-- manual_sources: PDF 원본 Drive URL 컬럼 추가
ALTER TABLE public.manual_sources ADD COLUMN IF NOT EXISTS drive_url text;
