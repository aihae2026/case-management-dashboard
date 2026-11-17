-- 열람 기록(view_log): 누가 어떤 대상자를·어떤 방식으로 열람했는지 남기는 감사 기록
--  · 앱이 화면에서 연 행동(대상자 상세 열기, 인쇄, 동의서·파일·녹음 열기, AI 리포트 생성)을 기록한다.
--    (DB는 SELECT 에 감사 트리거를 걸 수 없고, 앱은 로그인 때 대상자 전체를 한 번에 불러오기 때문에 화면 행동 기준으로 남긴다.)
--  · 입력만 가능하고 수정·삭제는 막는다(관리자도 못 지움). 읽기는 그 기관 관리자만.
--  · 대상자 이름은 저장하지 않고 번호(client_code)와 id만 남긴다. clients 와 FK 를 두지 않아 대상자를 삭제해도 기록은 남는다.
--  · 조회 전용(뷰어)도 기록해야 하므로 viewer 쓰기 차단 대상에 넣지 않는다.
-- 여러 번 실행해도 안전합니다.

create table if not exists public.view_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  user_id uuid,
  user_name text,
  client_id uuid,
  client_code text,
  action text not null,
  detail text,
  device text,
  ip text,
  created_at timestamptz not null default now()
);

create index if not exists view_log_org_time_idx on public.view_log (org_id, created_at desc);
create index if not exists view_log_org_client_idx on public.view_log (org_id, client_id, created_at desc);
create index if not exists view_log_org_user_idx on public.view_log (org_id, user_id, created_at desc);

-- 권한: 기본 권한(자동 부여)을 먼저 걷어내고 필요한 것만 준다. 수정·삭제는 주지 않는다.
revoke all on public.view_log from anon, authenticated;
grant select, insert on public.view_log to authenticated;
grant all on public.view_log to service_role;

alter table public.view_log enable row level security;

drop policy if exists "insert own view" on public.view_log;
create policy "insert own view" on public.view_log
  for insert to authenticated
  with check (user_id = auth.uid() and org_id = public.current_org_id());

drop policy if exists "admins read view" on public.view_log;
create policy "admins read view" on public.view_log
  for select to authenticated
  using (
    exists (
      select 1 from public.user_roles ur
      where ur.user_id = auth.uid() and ur.org_id = view_log.org_id and ur.role = 'admin'
    )
  );
