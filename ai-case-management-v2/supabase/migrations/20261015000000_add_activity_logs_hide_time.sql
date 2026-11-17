-- 상담기록 시간 표시 여부: true 이면 화면에서 시각을 숨기고 날짜만 보여 준다.
-- 신규 상담은 날짜는 고른 날짜, 시각은 입력한 실제 시각으로 저장하되 화면에는 날짜만 표시한다.
-- 기존 기록은 false(기본값)라서 지금처럼 시각이 보인다.
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS hide_time boolean NOT NULL DEFAULT false;
