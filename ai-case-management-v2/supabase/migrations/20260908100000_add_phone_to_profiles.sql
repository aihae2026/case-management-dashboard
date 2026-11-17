-- profiles: 연락처 컬럼 추가
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone text;
