-- 관리자가 기관 멤버를 안전하게 내보낼 수 있는 RPC 함수.
-- profiles UPDATE RLS(WITH CHECK)가 org_id=NULL(내보내기)을 막는 문제를, 서버측 권한검증을 거치는
-- SECURITY DEFINER 함수로 우회한다. 호출자는 반드시 대상과 같은 기관의 관리자여야 한다.

CREATE OR REPLACE FUNCTION public.remove_org_member(target uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_org uuid;
  target_org uuid;
BEGIN
  SELECT org_id INTO caller_org FROM public.profiles WHERE id = auth.uid();
  SELECT org_id INTO target_org FROM public.profiles WHERE id = target;

  IF caller_org IS NULL THEN
    RAISE EXCEPTION '기관 정보가 없습니다.';
  END IF;
  IF NOT public.has_role(auth.uid(), caller_org, 'admin'::public.app_role) THEN
    RAISE EXCEPTION '관리자만 멤버를 내보낼 수 있습니다.';
  END IF;
  IF target = auth.uid() THEN
    RAISE EXCEPTION '본인은 내보낼 수 없습니다.';
  END IF;
  IF target_org IS DISTINCT FROM caller_org THEN
    RAISE EXCEPTION '같은 기관의 멤버만 내보낼 수 있습니다.';
  END IF;

  -- 마지막 관리자는 내보낼 수 없음
  IF public.has_role(target, caller_org, 'admin'::public.app_role)
     AND (SELECT count(*) FROM public.user_roles
          WHERE org_id = caller_org AND role = 'admin'::public.app_role) <= 1 THEN
    RAISE EXCEPTION '마지막 관리자는 내보낼 수 없습니다.';
  END IF;

  UPDATE public.profiles SET org_id = NULL WHERE id = target;
  DELETE FROM public.user_roles WHERE user_id = target AND org_id = caller_org;
END;
$$;

GRANT EXECUTE ON FUNCTION public.remove_org_member(uuid) TO authenticated;
