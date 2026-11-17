-- ============================================================
-- 복순이 조회 함수(companion_lookup) 공유 비밀값 교체 — 운영 DB용 1회 작업 (Supabase SQL Editor)
--
-- 배경: 이전에는 비밀값이 함수 안에 평문 상수로 있었고 마이그레이션 파일에도 그대로 적혀 있었다.
--       이제 함수는 "비밀값의 SHA-256 해시"를 테이블(companion_lookup_secrets)에서 찾아 비교한다.
--       비밀값 자체는 DB·저장소 어디에도 남지 않는다.
-- 이 스크립트는 값을 포함하지 않는다. 옛 값은 현재 함수 정의에서 읽어 해시만 저장한다.
--
-- 순서 (복순이가 끊기지 않게 옛 값과 새 값이 잠시 둘 다 통한다):
--   1단계 = 아래 [1단계] 전체를 한 번에 실행 → 옛 비밀값은 계속 통한다(복순이 그대로 동작)
--   2단계 = [2단계]를 실행해 새 비밀값을 만들고 결과 화면의 값을 복사
--   3단계 = 복순이 서버의 CASE_LOOKUP_SECRET 을 새 값으로 바꾸고 다시 배포(복순이 쪽 채팅창에서)
--   4단계 = [3단계 확인] 쿼리로 새 값이 통하는지 확인, 복순이 조회가 정상인지 확인
--   5단계 = [5단계]로 옛 값을 폐기 → 옛 값은 더 이상 쓸 수 없다(이력에 남아 있어도 무효)
-- ============================================================

-- ───────── [1단계] 해시 테이블 + 옛 값 해시 저장 + 함수 교체 (한 번에 실행) ─────────
create table if not exists public.companion_lookup_secrets (
  id uuid primary key default gen_random_uuid(),
  secret_hash text not null unique,
  label text,
  created_at timestamptz not null default now()
);
alter table public.companion_lookup_secrets enable row level security;
revoke all on table public.companion_lookup_secrets from public, anon, authenticated;

do $$
declare
  fn  regprocedure := 'public.companion_lookup(text,text,text,text)'::regprocedure;
  def text;
  old text;
  -- 운영 함수는 키워드가 대문자(IF … THEN)로 저장되어 있을 수 있어 대소문자 구분 없이 찾는다
  chk constant text := 'if[[:space:]]+p_secret[[:space:]]+is[[:space:]]+null[[:space:]]+or[[:space:]]+p_secret[[:space:]]*<>[[:space:]]*v_secret[[:space:]]+then';
  decl constant text := 'v_secret[[:space:]]+constant[[:space:]]+text[[:space:]]*:=[[:space:]]*''([^'']+)''';
begin
  def := pg_get_functiondef(fn);

  -- 이미 해시 방식으로 바뀐 함수면 건너뛴다(여러 번 실행해도 안전)
  if position('companion_lookup_secrets' in def) > 0 then
    raise notice '이미 해시 방식입니다. 건너뜁니다.';
    return;
  end if;

  -- 옛 비밀값을 함수 정의에서 읽어 해시만 저장한다
  old := (regexp_match(def, decl, 'i'))[1];
  if old is null or def !~* chk then
    raise exception '함수 정의가 예상과 달라 자동 교체를 중단합니다(아무것도 바뀌지 않음). 정의를 확인해 주세요.';
  end if;
  insert into public.companion_lookup_secrets (secret_hash, label)
  values (encode(sha256(convert_to(old, 'UTF8')), 'hex'), 'old (migrated)')
  on conflict (secret_hash) do nothing;

  -- 함수: 상수 비교 → 해시 테이블 조회로 교체, 상수는 비운다
  def := regexp_replace(def, chk,
    'if p_secret is null or not exists (select 1 from public.companion_lookup_secrets s where s.secret_hash = encode(sha256(convert_to(p_secret, ''UTF8'')), ''hex'')) then', 'i');
  def := regexp_replace(def, 'v_secret[[:space:]]+constant[[:space:]]+text[[:space:]]*:=[[:space:]]*''[^'']+''', 'v_secret constant text := ''''', 'i');
  execute def;
  raise notice '함수를 해시 방식으로 교체했고, 옛 비밀값의 해시를 저장했습니다.';
end $$;

-- ───────── [2단계] 새 비밀값 만들기 (결과의 secret 값을 복사해 복순이 서버 설정에 넣는다) ─────────
-- with s as (select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') as secret),
--      ins as (
--        insert into public.companion_lookup_secrets (secret_hash, label)
--        select encode(sha256(convert_to(secret, 'UTF8')), 'hex'), 'new (' || to_char(now(), 'YYYY-MM-DD') || ')' from s
--        returning 1
--      )
-- select secret from s;

-- ───────── [3단계 확인] 새 값이 통하는지 (빈 조회라 bad_request 가 나오면 비밀값은 통과한 것) ─────────
-- select public.companion_lookup('', '', '', '여기에_새_비밀값');   -- 통과: {"ok": false, "reason": "bad_request"} / 불통: "unauthorized"

-- ───────── [5단계] 옛 값 폐기 (복순이가 새 값으로 정상 동작하는 것을 확인한 뒤에 실행) ─────────
-- delete from public.companion_lookup_secrets where label = 'old (migrated)';
-- select label, created_at from public.companion_lookup_secrets;   -- 새 값 1개만 남아야 한다
