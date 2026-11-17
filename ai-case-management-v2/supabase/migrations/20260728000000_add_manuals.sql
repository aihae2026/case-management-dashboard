-- 기관별 사례관리 매뉴얼 저장 (자연어 검색용) — 기관당 최신본 1개(org_id UNIQUE, 업로드 시 upsert)
CREATE TABLE IF NOT EXISTS public.manuals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  filename text NOT NULL,
  pages integer NOT NULL DEFAULT 0,
  chunks jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{ "page": int, "text": string }]
  uploaded_by text,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.manuals TO authenticated;
GRANT ALL ON public.manuals TO service_role;

ALTER TABLE public.manuals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "manuals_select_own_org" ON public.manuals
  FOR SELECT TO authenticated USING (org_id = public.current_org_id());
CREATE POLICY "manuals_insert_own_org" ON public.manuals
  FOR INSERT TO authenticated WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "manuals_update_own_org" ON public.manuals
  FOR UPDATE TO authenticated USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "manuals_delete_own_org" ON public.manuals
  FOR DELETE TO authenticated USING (org_id = public.current_org_id());
