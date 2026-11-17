-- 기관 주소(slug) 컬럼
--   이후 마이그레이션(20261008000000 대상자 고유번호 등)이 organizations.slug 를 사용한다.
--   이 컬럼은 원래 앱 개발 과정에서 만들어져 있었고 이 저장소의 마이그레이션에는 빠져 있었다.
--   빈 데이터베이스에 처음부터 설치할 때 'column "slug" does not exist' 로 멈추지 않도록 여기서 먼저 만든다.
--   이미 컬럼이 있는 데이터베이스에서는 아무것도 바꾸지 않는다(if not exists).
-- 롤백: alter table public.organizations drop column slug;   (다른 기능이 사용 중이면 지우지 마세요)
alter table public.organizations add column if not exists slug text;
