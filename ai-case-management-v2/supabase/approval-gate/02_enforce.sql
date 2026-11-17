-- ============================================================================
-- 승인 게이트 · 2단계: 실제로 막기 시작 (01_install.sql 설치 + 관찰 확인 후에 실행)
--   ① mode = enforce      : 소속 변경 → 승인 대기 강제 / 승인·역할·기관정보는 관리자만
--   ② data_block = on     : 승인 대기 계정은 대상자·상담 등 데이터 읽기/쓰기 불가
-- 되돌리기: 03_rollback.sql (또는 아래 '일시 해제' 두 줄)
-- ============================================================================
update guard.config set value = 'enforce', updated_at = now() where key = 'mode';
update guard.config set value = 'on',      updated_at = now() where key = 'data_block';

select key as 항목, value as 값 from guard.config where key in ('mode','data_block') order by key;

-- ── 일시 해제(문제가 생겼을 때 이 두 줄만 실행하면 즉시 이전 동작) ───────────
-- update guard.config set value = 'shadow', updated_at = now() where key = 'mode';
-- update guard.config set value = 'off',    updated_at = now() where key = 'data_block';
