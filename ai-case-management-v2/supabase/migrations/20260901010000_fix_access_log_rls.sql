-- access_log INSERT 정책에 org_id 검증 추가
-- 기존: user_id = auth.uid() 만 체크 → 다른 기관의 org_id로 삽입 가능
-- 변경: org_id도 현재 사용자의 소속 기관과 일치해야 함

DROP POLICY IF EXISTS "insert own access" ON public.access_log;
CREATE POLICY "insert own access" ON public.access_log
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND org_id = public.current_org_id()
  );
