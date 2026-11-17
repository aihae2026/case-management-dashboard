-- 담당 복지사 연락처 컬럼 (care-link.server.ts가 사례관리 연동 시 저장).
-- 운영 DB에는 이미 수동으로 추가돼 있으므로 if not exists로 안전하게 재실행 가능하게 둔다.
-- 새 DB를 만들 때 이 컬럼이 없으면 채팅의 사례관리 기록 로드와 로그인 연동이 실패한다.
alter table public.seniors add column if not exists staff_name text;
alter table public.seniors add column if not exists staff_phone text;
