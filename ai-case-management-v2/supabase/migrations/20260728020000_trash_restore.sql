-- 휴지통: 기관 구성원이 '삭제된' 항목을 조회·복구할 수 있게 (관리자 전용 감사와 별개)

-- 1) 구성원이 자기 기관의 DELETE 감사 기록을 볼 수 있게 (삭제 항목만 노출)
DROP POLICY IF EXISTS "members read own-org deletes" ON public.audit_log;
CREATE POLICY "members read own-org deletes" ON public.audit_log FOR SELECT TO authenticated
  USING (op = 'DELETE' AND org_id = public.current_org_id());

-- 2) 구성원용 복구 RPC: 삭제(DELETE)된 행만 재삽입. (관리자 전용 revert_audit와 달리 같은 기관이면 가능)
CREATE OR REPLACE FUNCTION public.restore_deleted(_audit_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.audit_log;
BEGIN
  SELECT * INTO a FROM public.audit_log WHERE id = _audit_id;
  IF a.id IS NULL THEN RAISE EXCEPTION '기록을 찾을 수 없습니다.'; END IF;
  IF a.op <> 'DELETE' THEN RAISE EXCEPTION '삭제된 항목만 복구할 수 있습니다.'; END IF;
  IF a.reverted_at IS NOT NULL THEN RAISE EXCEPTION '이미 복구된 항목입니다.'; END IF;
  IF a.org_id IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION '같은 기관의 항목만 복구할 수 있습니다.';
  END IF;
  IF a.table_name NOT IN ('clients','activity_logs','provisions','goals') THEN
    RAISE EXCEPTION '지원하지 않는 대상입니다: %', a.table_name;
  END IF;

  PERFORM set_config('audit.skip', 'on', true);
  EXECUTE format('INSERT INTO public.%I SELECT * FROM jsonb_populate_record(NULL::public.%I, $1)',
                 a.table_name, a.table_name) USING a.old_data;
  PERFORM set_config('audit.skip', 'off', true);

  UPDATE public.audit_log
  SET reverted_at = now(), reverted_by = auth.uid(),
      reverted_by_name = (SELECT name FROM public.profiles WHERE id = auth.uid())
  WHERE id = _audit_id;
END; $$;

GRANT EXECUTE ON FUNCTION public.restore_deleted(uuid) TO authenticated;
