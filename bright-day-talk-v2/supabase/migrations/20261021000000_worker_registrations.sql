-- worker_registrations: 어르신 기기 등록 (승인 대기 → 승인 / 거절)
--
-- 운영 DB에는 이미 있는 테이블이다. 이 파일은 새 DB를 만들 때 같은 구조를 재현하기 위한 것으로,
-- 모든 문장이 "if not exists"라서 이미 있는 DB에서 실행해도 아무것도 바꾸지 않는다.
--
-- 접근 방식: 코드는 서버(service_role)로만 이 테이블을 읽고 쓴다. 브라우저(anon)에는 어떤 정책도 열지 않는다.
--   - 승인 대기·승인 해제 감지는 서버 함수(getRegistrationStatus)로 확인하므로 Realtime(publication) 설정이 필요 없다.
--   - 예전 운영 DB에는 anon이 읽고 쓸 수 있는 정책(anon_select, anon_insert)이 있었으나 2026-10-21에 지웠다.
--     (사람 이름·전화번호·session_id가 공개 키만으로 읽히는 구멍이었다. 이 정책들을 다시 만들지 말 것)

create table if not exists public.worker_registrations (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  org_code text not null,
  org_name text,
  senior_name text not null,
  senior_phone text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  rejection_reason text,
  approved_at timestamptz,
  approved_by_email text,
  ip_address text,
  device_hint text,
  created_at timestamptz not null default now()
);

-- 일부 컬럼만 있는 DB에서도 안전하게 맞추기 위한 보강
alter table public.worker_registrations add column if not exists org_name text;
alter table public.worker_registrations add column if not exists rejection_reason text;
alter table public.worker_registrations add column if not exists approved_at timestamptz;
alter table public.worker_registrations add column if not exists approved_by_email text;
alter table public.worker_registrations add column if not exists ip_address text;
alter table public.worker_registrations add column if not exists device_hint text;

alter table public.worker_registrations enable row level security;

-- 2026-10-30 Supabase 정책 대응: 서버(service_role)만 접근한다
grant select, insert, update, delete on public.worker_registrations to service_role;
