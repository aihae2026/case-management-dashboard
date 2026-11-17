
-- Roles
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin','member');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id, role)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _org_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND org_id=_org_id AND role=_role)
$$;

DROP POLICY IF EXISTS "read roles in own org" ON public.user_roles;
CREATE POLICY "read roles in own org" ON public.user_roles FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());

DROP POLICY IF EXISTS "admins manage roles" ON public.user_roles;
CREATE POLICY "admins manage roles" ON public.user_roles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), org_id, 'admin'))
  WITH CHECK (public.has_role(auth.uid(), org_id, 'admin'));

-- Auto-assign role when profile joins/creates an org
CREATE OR REPLACE FUNCTION public.assign_org_role()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _has_admin boolean;
BEGIN
  IF NEW.org_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.org_id IS NOT DISTINCT FROM NEW.org_id THEN RETURN NEW; END IF;
  SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE org_id=NEW.org_id AND role='admin') INTO _has_admin;
  INSERT INTO public.user_roles(user_id, org_id, role)
  VALUES (NEW.id, NEW.org_id, CASE WHEN _has_admin THEN 'member'::public.app_role ELSE 'admin'::public.app_role END)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS profiles_assign_role ON public.profiles;
CREATE TRIGGER profiles_assign_role AFTER INSERT OR UPDATE OF org_id ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.assign_org_role();

-- Backfill: oldest profile per org becomes admin, rest members
INSERT INTO public.user_roles(user_id, org_id, role)
SELECT DISTINCT ON (p.org_id) p.id, p.org_id, 'admin'::public.app_role
FROM public.profiles p
WHERE p.org_id IS NOT NULL
ORDER BY p.org_id, p.created_at ASC
ON CONFLICT DO NOTHING;

INSERT INTO public.user_roles(user_id, org_id, role)
SELECT p.id, p.org_id, 'member'::public.app_role
FROM public.profiles p
WHERE p.org_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id=p.id AND r.org_id=p.org_id)
ON CONFLICT DO NOTHING;

-- Admins can update profiles in their org (rename, remove by clearing org_id)
DROP POLICY IF EXISTS "admins update org profiles" ON public.profiles;
CREATE POLICY "admins update org profiles" ON public.profiles FOR UPDATE TO authenticated
  USING (org_id IS NOT NULL AND public.has_role(auth.uid(), org_id, 'admin'))
  WITH CHECK (id = auth.uid() OR org_id IS NULL OR public.has_role(auth.uid(), org_id, 'admin'));
