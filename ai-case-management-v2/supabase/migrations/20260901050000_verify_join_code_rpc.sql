-- 기관코드 검증 공개 RPC
-- verifyJoinCode 서버 함수가 SUPABASE_SERVICE_ROLE_KEY 없이도 동작하도록
-- anon·authenticated 모두 호출 가능한 SECURITY DEFINER 함수를 추가한다.
-- 반환값: 코드가 유효하면 기관명(text), 없으면 NULL — 코드 자체는 노출하지 않음.

CREATE OR REPLACE FUNCTION public.verify_join_code(_code text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT name
  FROM organizations
  WHERE join_code ILIKE trim(_code)
  LIMIT 1;
$$;

-- 함수 직접 실행 권한 (트리거·RLS 무관하게 명시 부여)
GRANT EXECUTE ON FUNCTION public.verify_join_code(text) TO anon, authenticated;
