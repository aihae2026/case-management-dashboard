
-- 1) Extend clients with detailed intake fields
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS registered_at date DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS rrn_front text,
  ADD COLUMN IF NOT EXISTS rrn_back1 text,
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS housing text,
  ADD COLUMN IF NOT EXISTS education text,
  ADD COLUMN IF NOT EXISTS welfare_status text;

-- 2) Goals table
CREATE TABLE IF NOT EXISTS public.goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT '단기',
  title text NOT NULL,
  detail text,
  progress integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT '수동',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.goals TO authenticated;
GRANT ALL ON public.goals TO service_role;

ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "goals_select_own_org" ON public.goals
  FOR SELECT TO authenticated USING (org_id = public.current_org_id());
CREATE POLICY "goals_insert_own_org" ON public.goals
  FOR INSERT TO authenticated WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "goals_update_own_org" ON public.goals
  FOR UPDATE TO authenticated USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "goals_delete_own_org" ON public.goals
  FOR DELETE TO authenticated USING (org_id = public.current_org_id());

CREATE TRIGGER goals_touch_updated_at
  BEFORE UPDATE ON public.goals
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX IF NOT EXISTS goals_client_id_idx ON public.goals(client_id);
