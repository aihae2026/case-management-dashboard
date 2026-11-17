-- care_keywords: 담당 사회복지사가 지정한 대화 확인 주제 (최대 3개)
-- 복순이가 자연스럽게 대화에 녹여서 어르신 상태를 살필 수 있도록 함
-- 예: ["치매", "우울", "낙상 위험"]

ALTER TABLE seniors
  ADD COLUMN IF NOT EXISTS care_keywords TEXT[] DEFAULT '{}';
