
-- Organizations
CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  org_type TEXT NOT NULL DEFAULT '종합복지관',
  client_types TEXT[] NOT NULL DEFAULT ARRAY['노인','장애인','아동','가족']::text[],
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clients
CREATE TABLE public.clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  birth TEXT,
  phone TEXT,
  type TEXT NOT NULL,
  grade TEXT DEFAULT '일반관리',
  worker_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  worker_name TEXT,
  risk TEXT NOT NULL DEFAULT '정상',
  needs TEXT[] NOT NULL DEFAULT '{}',
  summary TEXT DEFAULT '',
  progress INT NOT NULL DEFAULT 0,
  last_contact_at TIMESTAMPTZ,
  last_contact_method TEXT,
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clients_org_idx ON public.clients(org_id);

-- Activity logs
CREATE TABLE public.activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  transcript TEXT,
  worker_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX activity_client_idx ON public.activity_logs(client_id);

-- Provisions
CREATE TABLE public.provisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  quantity TEXT,
  agency TEXT,
  note TEXT,
  provided_at DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX provisions_client_idx ON public.provisions(client_id);

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clients TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.activity_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provisions TO authenticated;
GRANT ALL ON public.organizations, public.profiles, public.clients, public.activity_logs, public.provisions TO service_role;

-- Helper: current user's org_id
CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id FROM public.profiles WHERE id = auth.uid()
$$;

-- RLS
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "member reads own org" ON public.organizations FOR SELECT TO authenticated
  USING (id = public.current_org_id() OR created_by = auth.uid());
CREATE POLICY "authed creates org" ON public.organizations FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());
CREATE POLICY "member updates own org" ON public.organizations FOR UPDATE TO authenticated
  USING (id = public.current_org_id()) WITH CHECK (id = public.current_org_id());

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read own profile" ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR org_id = public.current_org_id());
CREATE POLICY "insert own profile" ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());
CREATE POLICY "update own profile" ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org reads clients" ON public.clients FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());
CREATE POLICY "org writes clients" ON public.clients FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "org updates clients" ON public.clients FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "org deletes clients" ON public.clients FOR DELETE TO authenticated
  USING (org_id = public.current_org_id());

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org reads logs" ON public.activity_logs FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());
CREATE POLICY "org writes logs" ON public.activity_logs FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "org updates logs" ON public.activity_logs FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "org deletes logs" ON public.activity_logs FOR DELETE TO authenticated
  USING (org_id = public.current_org_id());

ALTER TABLE public.provisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org reads provisions" ON public.provisions FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());
CREATE POLICY "org writes provisions" ON public.provisions FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "org updates provisions" ON public.provisions FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "org deletes provisions" ON public.provisions FOR DELETE TO authenticated
  USING (org_id = public.current_org_id());

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, name, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    NEW.email
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER clients_touch BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
