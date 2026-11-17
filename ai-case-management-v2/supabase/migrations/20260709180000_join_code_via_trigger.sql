-- 영구 수정: organizations.join_code 자동 생성을 "컬럼 DEFAULT" 대신
-- "SECURITY DEFINER BEFORE INSERT 트리거"로 처리한다.
--
-- 배경: 기존에는 join_code 컬럼 DEFAULT 가 public.gen_join_code() 였다. 컬럼 DEFAULT 는
-- INSERT 하는 사용자(authenticated) 권한으로 평가되므로 gen_join_code() 에 대한 EXECUTE
-- 가 필요했고, 러버블 보안 에이전트가 그 EXECUTE 를 회수하면 기관 생성이
-- "permission denied for function gen_join_code" 로 깨졌다.
--
-- 트리거(SECURITY DEFINER, 소유자 권한으로 실행)로 옮기면 소유자 권한으로 gen_join_code()
-- 를 호출하므로 authenticated 에 EXECUTE 를 줄 필요가 없다. 따라서 보안 에이전트가
-- 다시 EXECUTE 를 회수해도 기관 생성이 깨지지 않는다(재발 방지).

-- 1) 컬럼 DEFAULT 제거
ALTER TABLE public.organizations ALTER COLUMN join_code DROP DEFAULT;

-- 2) join_code 자동 채움 트리거 함수 (소유자 권한으로 gen_join_code 호출)
CREATE OR REPLACE FUNCTION public.set_join_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.join_code IS NULL OR NEW.join_code = '' THEN
    NEW.join_code := public.gen_join_code();
  END IF;
  RETURN NEW;
END;
$$;

-- 트리거 전용 함수이므로 직접 실행 권한은 회수(트리거는 EXECUTE 권한과 무관하게 동작)
REVOKE ALL ON FUNCTION public.set_join_code() FROM PUBLIC, anon, authenticated;

-- 3) BEFORE INSERT 트리거 등록
DROP TRIGGER IF EXISTS organizations_set_join_code ON public.organizations;
CREATE TRIGGER organizations_set_join_code
  BEFORE INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.set_join_code();

-- 4) 이제 authenticated 는 gen_join_code 를 직접 실행할 필요가 없으므로 다시 잠근다.
--    (보안 에이전트 의도와 일치. 트리거는 소유자 권한으로 실행되어 영향 없음)
REVOKE EXECUTE ON FUNCTION public.gen_join_code() FROM authenticated;
