-- 종결보고서 테이블
CREATE TABLE IF NOT EXISTS closure_reports (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  closure_date  DATE,
  -- 사례관리 현황 (인테이크·재사정·사례회의·서비스계획·서비스점검 횟수)
  case_status   JSONB DEFAULT '{}'::jsonb,
  -- 서비스 제공현황 [{date, content}]
  service_history JSONB DEFAULT '[]'::jsonb,
  -- 종결 사유 (자유 텍스트)
  closure_reason  TEXT,
  -- 담당자 의견
  worker_opinion  TEXT,
  -- 종결 유형: '서비스거부' | '연락두절' | '이사' | '사망' | '기타'
  closure_type    TEXT,
  closure_type_detail TEXT,  -- 기타 시 상세
  -- 종결평가 결과: '종결' | '타기관의뢰'
  closure_result  TEXT DEFAULT '종결',
  referral_org    TEXT,      -- 타기관 의뢰 시 기관명
  written_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE closure_reports ENABLE ROW LEVEL SECURITY;

-- 같은 기관 멤버만 조회·수정 가능
CREATE POLICY "org members can view closure reports"
  ON closure_reports FOR SELECT
  USING (org_id IN (SELECT org_id FROM user_roles WHERE user_id = auth.uid()));

CREATE POLICY "org members can insert closure reports"
  ON closure_reports FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM user_roles WHERE user_id = auth.uid()));

CREATE POLICY "org members can update closure reports"
  ON closure_reports FOR UPDATE
  USING (org_id IN (SELECT org_id FROM user_roles WHERE user_id = auth.uid()));

CREATE POLICY "org members can delete closure reports"
  ON closure_reports FOR DELETE
  USING (org_id IN (SELECT org_id FROM user_roles WHERE user_id = auth.uid()));

grant select, insert, update, delete on public.closure_reports to authenticated;
grant select, insert, update, delete on public.closure_reports to service_role;
