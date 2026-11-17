-- 사례관리 계획 점검: 행동계획 항목의 '메모(manualNote)' 일괄 삭제
-- clients.note 컬럼 내 JSON 안에 중첩된 모든 manualNote 필드를 제거한다.
-- manualNote 는 옵셔널 string이며, id/text 뒤에 오므로 항상 쉼표가 앞에 붙는다.
-- 패턴: ,"manualNote":"<값>"  (값 안 이스케이프 문자 포함 처리)

UPDATE public.clients
SET note = regexp_replace(
  note,
  ',"manualNote":"([^"\\]|\\.)*"',
  '',
  'g'
)
WHERE note LIKE '%"manualNote"%';
