-- 말벗 챗봇(복순이) → 통합사례관리 "읽기 전용" 조회 RPC.
--
-- ⚠️ 보안 원칙(중요): 이 함수는 SELECT(읽기)만 한다. INSERT/UPDATE/DELETE 가 전혀 없어
--    복순이가 사례관리 DB 를 수정하는 것은 구조적으로 불가능하다.
-- 인증: 인자 p_secret 의 SHA-256 해시가 public.companion_lookup_secrets 에 있어야만 데이터를 돌려준다(복순이 서버만 호출).
--       비밀값 자체는 DB·저장소에 두지 않는다. 새로 설치할 때는 supabase/ops/rotate_companion_secret.sql 의 [2단계]로 만든다.
-- SECURITY DEFINER: 함수 소유자 권한으로 RLS 를 우회해 읽되, 반환 데이터는 시크릿으로 보호.
-- 비밀값의 해시 보관 테이블(일반 계정은 접근 불가, 함수만 읽는다)
create table if not exists public.companion_lookup_secrets (
  id uuid primary key default gen_random_uuid(),
  secret_hash text not null unique,
  label text,
  created_at timestamptz not null default now()
);
alter table public.companion_lookup_secrets enable row level security;
revoke all on table public.companion_lookup_secrets from public, anon, authenticated;

create or replace function public.companion_lookup(
  p_join_code text,
  p_name text,
  p_phone text,
  p_secret text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone  text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_org    record;
  v_client clients%rowtype;
  v_logs jsonb;
  v_goals jsonb;
  v_provisions jsonb;
begin
  -- 복순이(bright-day-talk)의 CASE_LOOKUP_SECRET 값의 해시가 등록되어 있어야 한다.
  if p_secret is null or not exists (
    select 1 from public.companion_lookup_secrets s
    where s.secret_hash = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;
  if coalesce(btrim(p_join_code), '') = ''
     or coalesce(btrim(p_name), '') = ''
     or v_phone = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;

  -- 1) 기관코드로 기관 확인
  select id, name into v_org
  from organizations
  where upper(join_code) = upper(btrim(p_join_code))
  limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'org_not_found');
  end if;

  -- 2) 이름 + 정규화 전화 일치 어르신 찾기
  select * into v_client
  from clients
  where org_id = v_org.id
    and btrim(name) = btrim(p_name)
    and regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = v_phone
  limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'client_not_found');
  end if;

  -- 3) 상담기록 / 목표 / 제공서비스 읽기 (모두 SELECT)
  select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) into v_logs
  from (
    select method, note, transcript, worker_name, created_at
    from activity_logs where client_id = v_client.id
    order by created_at desc limit 20
  ) l;

  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) into v_goals
  from (
    select kind, title, detail, progress, created_at
    from goals where client_id = v_client.id
    order by created_at desc
  ) g;

  select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) into v_provisions
  from (
    select category, title, provided_at
    from provisions where client_id = v_client.id
    order by provided_at desc limit 20
  ) p;

  -- 민감정보(주민번호·상세주소·전화 등)는 제외하고 말벗에 필요한 항목만 반환.
  return jsonb_build_object(
    'ok', true,
    'orgName', v_org.name,
    'seniorName', v_client.name,
    'clientId', v_client.id,
    'client', jsonb_build_object(
      'name', v_client.name,
      'birth', v_client.birth,
      'gender', v_client.gender,
      'worker_name', v_client.worker_name,
      'grade', v_client.grade,
      'risk', v_client.risk,
      'needs', v_client.needs,
      'housing', v_client.housing,
      'welfare_status', v_client.welfare_status,
      'summary', v_client.summary,
      'note', v_client.note
    ),
    'logs', v_logs,
    'goals', v_goals,
    'provisions', v_provisions
  );
end;
$$;

-- 직접 실행 권한은 복순이 서버(anon 키로 호출)에만 열어 둔다.
revoke all on function public.companion_lookup(text, text, text, text) from public;
grant execute on function public.companion_lookup(text, text, text, text) to anon, authenticated;
