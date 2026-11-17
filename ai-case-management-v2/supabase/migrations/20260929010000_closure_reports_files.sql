-- closure_reports 테이블에 첨부파일 컬럼 추가
ALTER TABLE closure_reports ADD COLUMN IF NOT EXISTS files JSONB DEFAULT '[]'::jsonb;
