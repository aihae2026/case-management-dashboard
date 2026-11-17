-- ================================================================
-- access_log 테이블 생성 (접속이력 트래킹)
-- Supabase SQL Editor에서 실행하세요.
-- ★ 이미 실행한 경우: 아래 "타입 수정" 구간만 추가 실행하면 됩니다.
-- ================================================================

-- 1) 테이블 생성 (처음 실행 시)
create table if not exists public.access_log (
  id          uuid        default gen_random_uuid() primary key,
  org_id      uuid        not null,              -- organizations.id 와 같은 타입 (UUID)
  user_id     uuid        references auth.users(id) on delete set null,
  user_name   text,
  action      text        not null default '접속',
  device      text,                              -- "PC" 또는 "모바일"
  created_at  timestamptz default now()
);

-- 2) org_id 타입 수정 (text → uuid) — 이미 테이블이 있고 text 타입인 경우만 실행
--    아직 데이터가 없으면 아래 두 줄 주석 해제 후 실행:
-- alter table public.access_log alter column org_id type uuid using org_id::uuid;

-- 3) 인덱스 (org_id 기준 조회 성능)
create index if not exists access_log_org_created
  on public.access_log (org_id, created_at desc);

-- 4) RLS 활성화
alter table public.access_log enable row level security;

-- 5) 기존 정책 삭제 후 재생성 (중복 방지)
drop policy if exists "insert own access log" on public.access_log;
drop policy if exists "select org access log"  on public.access_log;

-- 인증된 사용자는 자기 기관에 접속 기록 삽입 가능
create policy "insert own access log"
  on public.access_log for insert
  to authenticated
  with check (true);

-- 같은 기관 구성원은 접속 이력 조회 가능
create policy "select org access log"
  on public.access_log for select
  to authenticated
  using (
    org_id in (
      select org_id from public.profiles where id = auth.uid()
    )
  );
