-- AI 분석 결과 공유 캐시 (조직 단위, 사용자 간 공유)
CREATE TABLE public.ai_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  report_key TEXT NOT NULL,
  content TEXT NOT NULL,
  via TEXT NOT NULL DEFAULT 'AI',
  worker_name TEXT,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_reports_org_key_unique UNIQUE(org_id, report_key)
);

ALTER TABLE public.ai_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org reads ai_reports" ON public.ai_reports
  FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());

CREATE POLICY "org inserts ai_reports" ON public.ai_reports
  FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id());

CREATE POLICY "org updates ai_reports" ON public.ai_reports
  FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id())
  WITH CHECK (org_id = public.current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_reports TO authenticated;
GRANT ALL ON public.ai_reports TO service_role;
