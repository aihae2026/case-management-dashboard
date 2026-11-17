-- ============================================================================
-- 승인 게이트 · 관찰 기록 확인 (읽기 전용)
--   관찰 모드에서 '막혔을 동작'이 기록됩니다. 정상 사용 중인데 deny 가 찍히면 보내 주세요.
--   - force_pending / force_approved : 정상(기관 가입·기관 생성 시 기대되는 기록)
--   - deny:...                        : enforce 였다면 차단되었을 동작
--   - internal_error                  : 점검 필요
-- ============================================================================
select to_char(l.at at time zone 'Asia/Seoul', 'MM-DD HH24:MI:SS') as 시각,
       coalesce(p.email, l.actor::text) as 실행자,
       l.table_name as 테이블, l.op as 동작, l.rule as 판정, l.mode as 모드, l.detail as 상세
from guard.log l
left join public.profiles p on p.id = l.actor
order by l.id desc
limit 100;
