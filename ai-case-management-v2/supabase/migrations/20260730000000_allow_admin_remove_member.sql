-- 관리자가 기관 멤버를 내보낼 수 있도록 profiles UPDATE 정책 보완.
-- 기존 정책의 WITH CHECK가 org_id를 NULL로 바꾸는 것(=내보내기)을 막고 있어 삭제가 되지 않던 문제 수정.
-- USING 절에서 이미 "대상 행이 내 기관이고 내가 관리자"임을 확인하므로, WITH CHECK에서 org_id NULL(내보내기)을 허용해도 안전.

DROP POLICY IF EXISTS "admins update org profiles" ON public.profiles;
CREATE POLICY "admins update org profiles"
ON public.profiles
FOR UPDATE
TO authenticated
USING (org_id IS NOT NULL AND public.has_role(auth.uid(), org_id, 'admin'::public.app_role))
WITH CHECK (
  -- 같은 기관 유지(정보 수정) 또는 기관에서 내보내기(org_id = NULL) 허용
  (org_id = public.current_org_id() AND public.has_role(auth.uid(), org_id, 'admin'::public.app_role))
  OR org_id IS NULL
);
