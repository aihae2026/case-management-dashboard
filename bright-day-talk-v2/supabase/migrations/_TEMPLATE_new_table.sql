-- ============================================================
-- 새 테이블 마이그레이션 템플릿
-- Supabase 2026-10-30 정책 변경:
--   public 스키마 신규 테이블은 GRANT를 명시해야 Data API 접근 가능.
--   아래 GRANT 3줄을 CREATE TABLE 뒤에 반드시 추가할 것.
-- ============================================================

-- create table public.테이블명 (
--   id uuid primary key default gen_random_uuid(),
--   ...
-- );

-- grant select                          on public.테이블명 to anon;
-- grant select, insert, update, delete  on public.테이블명 to authenticated;
-- grant select, insert, update, delete  on public.테이블명 to service_role;
