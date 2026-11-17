-- 기관별 추가 참고자료 (매뉴얼 외 뉴스·YouTube·PDF 등)
CREATE TABLE public.manual_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('pdf', 'url', 'youtube')),
  title text NOT NULL,
  url text,
  drive_id text,
  chunks jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.manual_sources TO authenticated;
GRANT ALL ON public.manual_sources TO service_role;

ALTER TABLE public.manual_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "manual_sources_select" ON public.manual_sources
  FOR SELECT TO authenticated USING (org_id = public.current_org_id());
CREATE POLICY "manual_sources_insert" ON public.manual_sources
  FOR INSERT TO authenticated WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "manual_sources_delete" ON public.manual_sources
  FOR DELETE TO authenticated USING (org_id = public.current_org_id());
