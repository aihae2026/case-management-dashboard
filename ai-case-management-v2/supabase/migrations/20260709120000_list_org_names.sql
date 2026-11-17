-- Public directory of organization names for the auth screen.
-- Powers (1) the "소속 기관" dropdown on the sign-in tab and
-- (2) the org-name duplicate check on the sign-up tab.
--
-- The organizations table RLS only lets an authenticated member read their own
-- org, so anon/other users cannot list orgs directly. This SECURITY DEFINER
-- function exposes ONLY id + name (never join_code or any other column) to
-- anon and authenticated roles, leaving row-level security on the table intact.

CREATE OR REPLACE FUNCTION public.list_org_names()
RETURNS TABLE (id uuid, name text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT o.id, o.name
  FROM public.organizations o
  ORDER BY o.name;
$$;

REVOKE ALL ON FUNCTION public.list_org_names() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_org_names() TO anon, authenticated;
