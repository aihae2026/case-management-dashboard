-- 기관 가입코드 검증을 "정확 일치"로 변경한다.
-- 이전에는 join_code ILIKE trim(_code) 라서 '%'·'_' 와일드카드로 코드를 한 글자씩 추측할 수 있었다.
-- 대소문자는 지금처럼 구분하지 않는다.
CREATE OR REPLACE FUNCTION public.verify_join_code(_code text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT name
  FROM organizations
  WHERE upper(join_code) = upper(trim(_code))
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.verify_join_code(text) TO anon, authenticated;
