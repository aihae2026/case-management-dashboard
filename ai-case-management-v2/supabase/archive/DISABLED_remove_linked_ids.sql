-- ⚠️ DISABLED — migrations/ 폴더에서 archive/로 이동됨 (2026-09-09)
-- 이 파일을 migrations/ 로 옮기지 마세요.
-- 실행 시 모든 대상자의 계획 연동 데이터(linkedLogIds, linkedProvIds 등)가 영구 삭제됩니다.
-- 보관 목적으로만 존재합니다.
--
-- 원래 목적: 계획 달성도 연계 데이터 일괄 초기화
-- clients.note 안 CarePlanAction의 linkedLogIds / linkedProvIds / excludedLogIds / excludedProvIds 제거

/*
UPDATE public.clients
SET note = regexp_replace(
  regexp_replace(
    regexp_replace(
      regexp_replace(
        note,
        ',"linkedLogIds":\[[^\]]*\]',
        '',
        'g'
      ),
      ',"linkedProvIds":\[[^\]]*\]',
      '',
      'g'
    ),
    ',"excludedLogIds":\[[^\]]*\]',
    '',
    'g'
  ),
  ',"excludedProvIds":\[[^\]]*\]',
  '',
  'g'
)
WHERE note ~ '"linkedLogIds"|"linkedProvIds"|"excludedLogIds"|"excludedProvIds"';
*/
