
-- 1. Fix profiles admin update policy: prevent cross-org reassignment
DROP POLICY IF EXISTS "admins update org profiles" ON public.profiles;
CREATE POLICY "admins update org profiles"
ON public.profiles
FOR UPDATE
TO authenticated
USING (org_id IS NOT NULL AND public.has_role(auth.uid(), org_id, 'admin'::public.app_role))
WITH CHECK (
  org_id IS NOT NULL
  AND org_id = public.current_org_id()
  AND public.has_role(auth.uid(), org_id, 'admin'::public.app_role)
);

-- 2. Revoke public execute on SECURITY DEFINER helpers not meant to be called via API.
-- These are invoked by RLS, triggers, or auth hooks and don't need direct role EXECUTE.
REVOKE ALL ON FUNCTION public.has_role(uuid, uuid, public.app_role) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.current_org_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gen_join_code() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_org_role() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;

-- join_org_by_code is an intentional RPC for signed-in users
REVOKE ALL ON FUNCTION public.join_org_by_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_org_by_code(text) TO authenticated;
