-- activity_logs.transcript 컬럼의 drive: 참조 포맷 문서화
-- "drive:<fileId>" 형태로 저장된 값은 Google Drive 파일 참조이며,
-- companion-proxy 또는 drive-proxy 엣지 함수를 통해 원문을 조회한다.
COMMENT ON COLUMN public.activity_logs.transcript IS
  'Transcript text. When longer than 1000 chars, migrated to Drive and stored as "drive:<fileId>" reference. Read via drive-proxy edge function.';
