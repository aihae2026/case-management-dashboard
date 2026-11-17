-- 통합사례관리 연동: 로그인 시 확인한 어르신의 케어 기록을 세션에 연결한다.
-- care_context 는 통합사례관리에서 "읽기 전용"으로 가져온 요약 텍스트(챗 근거용)이며,
-- 통합사례관리 DB 자체는 절대 수정하지 않는다(복순이는 읽기 함수만 호출).
ALTER TABLE public.seniors
  ADD COLUMN IF NOT EXISTS org_code text,
  ADD COLUMN IF NOT EXISTS care_client_id text,   -- 통합사례관리 clients.id (연결 식별용)
  ADD COLUMN IF NOT EXISTS care_context text,      -- 상담/재사정/의견 요약(말벗 근거)
  ADD COLUMN IF NOT EXISTS care_synced_at timestamptz;
