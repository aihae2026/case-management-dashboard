-- 상세주소를 별도 컬럼으로 분리
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS address_detail text;

-- 동거형태 컬럼 추가 (독거/부부/가족/조손/기타)
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS household text;
