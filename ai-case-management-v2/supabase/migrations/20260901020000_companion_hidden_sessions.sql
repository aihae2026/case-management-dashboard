-- 복순이 대화 숨김(삭제) 목록 — 관리자가 숨긴 세션을 모니터링에서 제외
CREATE TABLE IF NOT EXISTS companion_hidden_sessions (
  session_id TEXT NOT NULL,
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  hidden_at  TIMESTAMPTZ DEFAULT NOW(),
  hidden_by  UUID REFERENCES auth.users(id),
  PRIMARY KEY (session_id, org_id)
);

ALTER TABLE companion_hidden_sessions ENABLE ROW LEVEL SECURITY;

-- 같은 기관 멤버는 조회 가능
CREATE POLICY "org members can view hidden sessions"
  ON companion_hidden_sessions FOR SELECT
  USING (org_id IN (SELECT org_id FROM user_roles WHERE user_id = auth.uid()));

-- 관리자만 숨김 처리
CREATE POLICY "admins can hide sessions"
  ON companion_hidden_sessions FOR INSERT
  WITH CHECK (org_id IN (
    SELECT org_id FROM user_roles WHERE user_id = auth.uid() AND role = 'admin'
  ));

-- 관리자만 숨김 취소
CREATE POLICY "admins can unhide sessions"
  ON companion_hidden_sessions FOR DELETE
  USING (org_id IN (
    SELECT org_id FROM user_roles WHERE user_id = auth.uid() AND role = 'admin'
  ));

grant select, insert, delete on public.companion_hidden_sessions to authenticated;
grant select, insert, update, delete on public.companion_hidden_sessions to service_role;
