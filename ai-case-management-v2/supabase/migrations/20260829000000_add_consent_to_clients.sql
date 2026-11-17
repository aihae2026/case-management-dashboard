-- AI 기능 동의서 Drive 링크를 clients 테이블에 추가
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS consent_drive_id  text,
  ADD COLUMN IF NOT EXISTS consent_drive_url text;
