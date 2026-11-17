-- 대상자 가계도(genogram) 저장용 컬럼.
-- 손으로 그린 가계도를 PNG data URL(base64) 문자열로 저장한다. (선택 항목)
alter table public.clients
  add column if not exists genogram text;

comment on column public.clients.genogram is '대상자 가계도 이미지 (PNG data URL). 사례관리 담당자가 직접 그려 저장.';
