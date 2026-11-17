-- consent_audit_logs에 접속 IP 주소 컬럼 추가
-- "어느 장소/네트워크에서 작성되었는지" 증명용

alter table public.consent_audit_logs
  add column if not exists ip_address text;
