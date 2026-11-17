-- consent_audit_logs: 자필 서명 동의서 감사 기록
-- 서명 일시·서명자·담당자·SHA-256 해시·브라우저 정보를 저장해 법적 증명력 확보

create table if not exists public.consent_audit_logs (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references public.organizations(id),
  client_id         uuid        not null references public.clients(id) on delete cascade,
  signer_name       text        not null,          -- 대상자 이름
  worker_name       text,                           -- 입회 담당자 이름
  signed_at         timestamptz not null,           -- 서버 기준 서명 일시
  document_hash     text        not null,           -- SHA-256 (동의서 전문 + 서명 이미지)
  user_agent        text,                           -- 브라우저/OS 환경
  signature_strokes int,                            -- 서명 획수 (0이면 서명 안 한 것)
  drive_file_id     text,                           -- Google Drive 파일 ID
  drive_url         text,                           -- Google Drive 공유 URL
  created_at        timestamptz default now()
);

alter table public.consent_audit_logs enable row level security;

-- 같은 기관 구성원만 조회
create policy "org members read own consent audit logs"
  on public.consent_audit_logs for select
  using (org_id = public.current_org_id());

-- 같은 기관 구성원만 삽입
create policy "org members insert consent audit logs"
  on public.consent_audit_logs for insert
  with check (org_id = public.current_org_id());
