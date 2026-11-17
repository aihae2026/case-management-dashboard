-- 접속 기록에 접속 IP 칸 추가 (접속할 때마다 기록 + 접속지 확인용)
-- 새 테이블이 아니라 기존 테이블에 칸만 더하므로 권한(GRANT)·정책은 그대로입니다. 여러 번 실행해도 안전합니다.
alter table public.access_log add column if not exists ip text;
