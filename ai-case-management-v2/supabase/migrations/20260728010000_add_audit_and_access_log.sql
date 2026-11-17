-- 관리자 감사(변경 히스토리)·접속 로그 + 되돌리기(복구) 기능
-- 대상 테이블(clients/activity_logs/provisions/goals)의 모든 INSERT/UPDATE/DELETE를 자동 기록.

-- 1) 변경 감사 로그
CREATE TABLE IF NOT EXISTS public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  table_name text NOT NULL,
  row_id uuid,
  op text NOT NULL, -- INSERT | UPDATE | DELETE
  old_data jsonb,
  new_data jsonb,
  actor_id uuid,
  actor_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reverted_at timestamptz,
  reverted_by uuid,
  reverted_by_name text
);
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON public.audit_log(org_id, created_at DESC);

GRANT SELECT ON public.audit_log TO authenticated;
GRANT ALL ON public.audit_log TO service_role;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins read audit" ON public.audit_log;
CREATE POLICY "admins read audit" ON public.audit_log FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.org_id = audit_log.org_id AND ur.role = 'admin'
  ));

-- 2) 접속 로그
CREATE TABLE IF NOT EXISTS public.access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  user_id uuid,
  user_name text,
  action text NOT NULL DEFAULT 'login',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS access_log_org_idx ON public.access_log(org_id, created_at DESC);

GRANT SELECT, INSERT ON public.access_log TO authenticated;
GRANT ALL ON public.access_log TO service_role;
ALTER TABLE public.access_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "insert own access" ON public.access_log;
CREATE POLICY "insert own access" ON public.access_log FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "admins read access" ON public.access_log;
CREATE POLICY "admins read access" ON public.access_log FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.org_id = access_log.org_id AND ur.role = 'admin'
    )
  );

-- 3) 감사 트리거 함수
CREATE OR REPLACE FUNCTION public.audit_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name text;
  v_org uuid;
  v_row uuid;
  v_old jsonb;
  v_new jsonb;
BEGIN
  -- 되돌리기 작업 중에는 감사 생략
  IF current_setting('audit.skip', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF (TG_OP = 'DELETE') THEN
    v_old := to_jsonb(OLD); v_org := OLD.org_id; v_row := OLD.id;
  ELSIF (TG_OP = 'INSERT') THEN
    v_new := to_jsonb(NEW); v_org := NEW.org_id; v_row := NEW.id;
  ELSE
    v_old := to_jsonb(OLD); v_new := to_jsonb(NEW); v_org := NEW.org_id; v_row := NEW.id;
  END IF;

  SELECT name INTO v_name FROM public.profiles WHERE id = v_actor;

  INSERT INTO public.audit_log(org_id, table_name, row_id, op, old_data, new_data, actor_id, actor_name)
  VALUES (v_org, TG_TABLE_NAME, v_row, TG_OP, v_old, v_new, v_actor, v_name);

  RETURN COALESCE(NEW, OLD);
END; $$;

-- 4) 대상 테이블에 트리거 부착
DROP TRIGGER IF EXISTS audit_clients ON public.clients;
CREATE TRIGGER audit_clients AFTER INSERT OR UPDATE OR DELETE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();
DROP TRIGGER IF EXISTS audit_activity_logs ON public.activity_logs;
CREATE TRIGGER audit_activity_logs AFTER INSERT OR UPDATE OR DELETE ON public.activity_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();
DROP TRIGGER IF EXISTS audit_provisions ON public.provisions;
CREATE TRIGGER audit_provisions AFTER INSERT OR UPDATE OR DELETE ON public.provisions
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();
DROP TRIGGER IF EXISTS audit_goals ON public.goals;
CREATE TRIGGER audit_goals AFTER INSERT OR UPDATE OR DELETE ON public.goals
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- 5) 되돌리기(복구) RPC — 관리자만. DELETE→재삽입, INSERT→삭제, UPDATE→이전값 복원
CREATE OR REPLACE FUNCTION public.revert_audit(_audit_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.audit_log;
  v_is_admin boolean;
  v_cols text;
BEGIN
  SELECT * INTO a FROM public.audit_log WHERE id = _audit_id;
  IF a.id IS NULL THEN RAISE EXCEPTION '감사 기록을 찾을 수 없습니다.'; END IF;
  IF a.reverted_at IS NOT NULL THEN RAISE EXCEPTION '이미 되돌린 기록입니다.'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND org_id = a.org_id AND role = 'admin'
  ) INTO v_is_admin;
  IF NOT v_is_admin THEN RAISE EXCEPTION '관리자만 되돌릴 수 있습니다.'; END IF;
  IF a.table_name NOT IN ('clients','activity_logs','provisions','goals') THEN
    RAISE EXCEPTION '지원하지 않는 대상입니다: %', a.table_name;
  END IF;

  PERFORM set_config('audit.skip', 'on', true); -- 되돌리기 자체는 감사 생략

  IF a.op = 'DELETE' THEN
    EXECUTE format('INSERT INTO public.%I SELECT * FROM jsonb_populate_record(NULL::public.%I, $1)',
                   a.table_name, a.table_name) USING a.old_data;
  ELSIF a.op = 'INSERT' THEN
    EXECUTE format('DELETE FROM public.%I WHERE id = $1', a.table_name) USING a.row_id;
  ELSE -- UPDATE
    SELECT string_agg(format('%I = r.%I', column_name, column_name), ', ') INTO v_cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = a.table_name AND column_name <> 'id';
    EXECUTE format('UPDATE public.%I AS t SET %s FROM jsonb_populate_record(NULL::public.%I, $1) AS r WHERE t.id = $2',
                   a.table_name, v_cols, a.table_name) USING a.old_data, a.row_id;
  END IF;

  PERFORM set_config('audit.skip', 'off', true);

  UPDATE public.audit_log
  SET reverted_at = now(), reverted_by = auth.uid(),
      reverted_by_name = (SELECT name FROM public.profiles WHERE id = auth.uid())
  WHERE id = _audit_id;
END; $$;

GRANT EXECUTE ON FUNCTION public.revert_audit(uuid) TO authenticated;
