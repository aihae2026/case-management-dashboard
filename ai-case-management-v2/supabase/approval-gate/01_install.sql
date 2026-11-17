-- ============================================================================
-- 승인 게이트 · 1단계: 설치 (관찰 모드)
--   - 설치만으로는 앱 동작이 바뀌지 않습니다. (mode = shadow: 기록만 하고 막지 않음)
--   - 여러 번 실행해도 안전합니다. 문제가 생기면 03_rollback.sql 한 번이면 원상복구.
--   - 접근 규칙(current_org_id)의 '원본 정의'를 guard.config 에 저장한 뒤 교체합니다.
-- ============================================================================
begin;

-- ── 안전 점검: 예상과 다른 구조면 아무것도 바꾸지 않고 중단 ─────────────────
do $$
begin
  if to_regclass('public.profiles') is null or to_regclass('public.user_roles') is null
     or to_regclass('public.organizations') is null then
    raise exception '중단: profiles / user_roles / organizations 테이블을 찾지 못했습니다.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='profiles' and column_name='status') then
    raise exception '중단: profiles.status 컬럼이 없습니다.';
  end if;
  if exists (select 1 from public.profiles where status is null or status not in ('approved','pending')) then
    raise exception '중단: status 가 approved/pending 이 아닌 계정이 있습니다. 먼저 확인이 필요합니다.';
  end if;
  if pg_get_functiondef('public.current_org_id()'::regprocedure) not ilike '%auth.uid()%' then
    raise exception '중단: current_org_id() 정의가 예상과 다릅니다.';
  end if;
end $$;

-- ── 보관소: 일반 API 에 노출되지 않는 별도 스키마 ──────────────────────────
create schema if not exists guard;
revoke all on schema guard from public;
grant usage on schema guard to authenticated, service_role;

create table if not exists guard.config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
create table if not exists guard.log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor uuid,
  rule text not null,
  op text,
  table_name text,
  mode text,
  detail jsonb
);
alter table guard.config enable row level security;
alter table guard.log enable row level security;
revoke all on guard.config, guard.log from public, anon, authenticated;
grant all on guard.config, guard.log to service_role;

insert into guard.config(key, value) values ('mode', 'shadow')    on conflict (key) do nothing;
insert into guard.config(key, value) values ('data_block', 'off') on conflict (key) do nothing;
-- 원본 접근규칙 정의 보관(롤백용). 이미 있으면 덮어쓰지 않음.
insert into guard.config(key, value)
  values ('orig_current_org_id_def', pg_get_functiondef('public.current_org_id()'::regprocedure))
  on conflict (key) do nothing;

-- ── 도우미 함수 ────────────────────────────────────────────────────────────
create or replace function guard.cfg(k text) returns text
language sql stable security definer set search_path = guard, public as $$
  select value from guard.config where key = k
$$;

create or replace function guard.note(_rule text, _op text, _tbl text, _detail jsonb) returns void
language plpgsql security definer set search_path = guard, public as $$
begin
  insert into guard.log(actor, rule, op, table_name, mode, detail)
  values (auth.uid(), _rule, _op, _tbl, guard.cfg('mode'), _detail);
exception when others then
  null; -- 기록 실패가 서비스에 영향을 주지 않도록
end $$;

-- 호출자가 '그 기관의 승인된 관리자'인가 (자기 프로필 소속 = 그 기관 + 관리자 역할)
create or replace function guard.is_org_admin(_uid uuid, _org uuid) returns boolean
language sql stable security definer set search_path = guard, public as $$
  select _uid is not null and _org is not null and exists (
    select 1
    from public.profiles p
    join public.user_roles r on r.user_id = p.id and r.org_id = p.org_id and r.role = 'admin'
    where p.id = _uid and p.org_id = _org and p.status = 'approved'
  )
$$;

-- 프로필 변경 판정(순수 함수): ok | force_pending | force_approved | deny:사유
create or replace function guard.profile_verdict(
  _old_org uuid, _old_status text, _id uuid, _new_org uuid, _new_status text, _caller uuid
) returns text
language plpgsql stable security definer set search_path = guard, public as $$
begin
  if _caller is null then return 'ok'; end if;
  if _new_org is not distinct from _old_org and _new_status is not distinct from _old_status then
    return 'ok';
  end if;

  -- 소속이 바뀌는 경우
  if _new_org is distinct from _old_org then
    if _new_org is null then                       -- 기관에서 나감/내보냄
      if _id = _caller then return 'ok'; end if;
      if guard.is_org_admin(_caller, _old_org) then return 'ok'; end if;
      return 'deny:관리자만 다른 사람을 기관에서 내보낼 수 있습니다';
    end if;
    if _id <> _caller then
      return 'deny:다른 사람을 임의로 기관에 넣을 수 없습니다';
    end if;
    -- 내가 직접 만든(아직 나 외에 아무도 없는) 기관 → 승인 없이 시작
    if exists (select 1 from public.organizations o where o.id = _new_org and o.created_by = _caller)
       and not exists (select 1 from public.profiles q where q.org_id = _new_org and q.id <> _caller) then
      return 'force_approved';
    end if;
    return 'force_pending';                         -- 그 외 모든 소속 변경은 승인 대기
  end if;

  -- 소속은 그대로, 상태만 바뀌는 경우
  if _new_org is null then return 'ok'; end if;     -- 기관 없는 계정의 상태값은 의미 없음
  if _new_status = 'pending' and _id = _caller then return 'ok'; end if;  -- 스스로 '대기'로 내리기는 무해
  if _id = _caller then return 'deny:본인의 승인 상태는 본인이 바꿀 수 없습니다'; end if;
  if guard.is_org_admin(_caller, _new_org) then return 'ok'; end if;
  return 'deny:그 기관의 관리자만 승인 상태를 바꿀 수 있습니다';
end $$;

-- ── 트리거 1: profiles (소속·승인상태 보호) ────────────────────────────────
-- 사용자가 로그인한 상태(auth.uid() 있음)의 변경만 검사 → 대시보드·서비스키(서버 관리 기능)는 영향 없음
create or replace function guard.profiles_trigger() returns trigger
language plpgsql security definer set search_path = guard, public as $$
declare
  _caller uuid; _mode text; _v text := 'ok';
begin
  begin
    _caller := auth.uid();
    if _caller is null then return new; end if;
    _mode := coalesce(guard.cfg('mode'), 'off');
    if _mode = 'off' then return new; end if;
    if tg_op = 'INSERT' then
      -- upsert(ON CONFLICT) 는 INSERT 트리거를 먼저 거침 → 이미 행이 있으면 UPDATE 단계에서 검사
      if exists (select 1 from public.profiles where id = new.id) then return new; end if;
      _v := guard.profile_verdict(null, null, new.id, new.org_id, new.status, _caller);
    else
      _v := guard.profile_verdict(old.org_id, old.status, new.id, new.org_id, new.status, _caller);
    end if;
  exception when others then
    perform guard.note('internal_error', tg_op, 'profiles', jsonb_build_object('error', sqlerrm));
    return new;  -- 내부 오류는 통과(서비스 우선)
  end;

  if _v = 'ok' then return new; end if;
  perform guard.note(_v, tg_op, 'profiles', jsonb_build_object(
    'target', new.id,
    'old_org', case when tg_op = 'UPDATE' then old.org_id end, 'new_org', new.org_id,
    'old_status', case when tg_op = 'UPDATE' then old.status end, 'new_status', new.status));
  if _mode <> 'enforce' then return new; end if;   -- 관찰 모드: 기록만
  if _v = 'force_pending'  then new.status := 'pending';  return new; end if;
  if _v = 'force_approved' then new.status := 'approved'; return new; end if;
  raise exception '승인 게이트: %', substr(_v, 6) using errcode = '42501';
end $$;

drop trigger if exists profiles_approval_guard on public.profiles;
create trigger profiles_approval_guard
  before insert or update on public.profiles
  for each row execute function guard.profiles_trigger();

-- ── 트리거 2: user_roles (역할 부여·삭제는 그 기관 관리자만) ────────────────
-- SECURITY INVOKER: 앱이 API 로 직접 호출한 경우(current_user = authenticated)만 검사.
-- 시스템 함수(assign_org_role 등)·서비스키·대시보드는 영향 없음.
create or replace function guard.user_roles_trigger() returns trigger
language plpgsql security invoker set search_path = guard, public as $$
declare
  _caller uuid; _mode text; _org uuid; _ok boolean := true;
begin
  if current_user not in ('authenticated', 'anon') then return coalesce(new, old); end if;
  begin
    _caller := auth.uid();
    _mode := coalesce(guard.cfg('mode'), 'off');
    if _mode = 'off' then return coalesce(new, old); end if;
    _org := case when tg_op = 'INSERT' then new.org_id else old.org_id end;
    _ok := guard.is_org_admin(_caller, _org);
    if tg_op = 'UPDATE' and new.org_id is distinct from old.org_id then _ok := false; end if;
  exception when others then
    perform guard.note('internal_error', tg_op, 'user_roles', jsonb_build_object('error', sqlerrm));
    return coalesce(new, old);
  end;
  if _ok then return coalesce(new, old); end if;
  perform guard.note('deny:관리자만 역할을 바꿀 수 있습니다', tg_op, 'user_roles', jsonb_build_object(
    'org', _org,
    'user', case when tg_op = 'DELETE' then old.user_id else new.user_id end,
    'role', case when tg_op = 'DELETE' then old.role::text else new.role::text end));
  if _mode <> 'enforce' then return coalesce(new, old); end if;
  raise exception '승인 게이트: 관리자만 역할을 바꿀 수 있습니다' using errcode = '42501';
end $$;

drop trigger if exists user_roles_approval_guard on public.user_roles;
create trigger user_roles_approval_guard
  before insert or update or delete on public.user_roles
  for each row execute function guard.user_roles_trigger();

-- ── 트리거 3: organizations (기관 정보 수정은 그 기관 관리자만) ─────────────
create or replace function guard.organizations_trigger() returns trigger
language plpgsql security invoker set search_path = guard, public as $$
declare
  _caller uuid; _mode text; _ok boolean := true;
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  begin
    _caller := auth.uid();
    _mode := coalesce(guard.cfg('mode'), 'off');
    if _mode = 'off' then return new; end if;
    _ok := guard.is_org_admin(_caller, old.id)
           and new.id = old.id and new.created_by is not distinct from old.created_by;
  exception when others then
    perform guard.note('internal_error', tg_op, 'organizations', jsonb_build_object('error', sqlerrm));
    return new;
  end;
  if _ok then return new; end if;
  perform guard.note('deny:기관 정보는 관리자만 바꿀 수 있습니다', tg_op, 'organizations', jsonb_build_object('org', old.id));
  if _mode <> 'enforce' then return new; end if;
  raise exception '승인 게이트: 기관 정보는 관리자만 바꿀 수 있습니다' using errcode = '42501';
end $$;

drop trigger if exists organizations_approval_guard on public.organizations;
create trigger organizations_approval_guard
  before update on public.organizations
  for each row execute function guard.organizations_trigger();

-- 함수 실행 권한: 로그인 사용자·서버만 (익명 불가). guard 스키마는 API 로 노출되지 않음.
revoke execute on all functions in schema guard from public, anon;
grant execute on all functions in schema guard to authenticated, service_role;

-- ── 접근 규칙: 승인 대기 계정의 데이터 접근 차단 스위치(기본 off = 지금과 동일) ──
create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select p.org_id from public.profiles p
  where p.id = auth.uid()
    and (p.status = 'approved' or guard.cfg('data_block') is distinct from 'on')
$$;

commit;

select '설치 완료 — 현재 모드' as 항목, guard.cfg('mode') as 값
union all select '승인대기 데이터 차단', guard.cfg('data_block');
