-- ai_reports에 DELETE 권한이 부여되어 있으나 RLS DELETE 정책이 없어
-- 같은 기관 내 누구든 레코드를 삭제할 수 있는 상태였음.
-- 앱 UI에 ai_reports 삭제 기능이 없으므로 GRANT에서 제거.
REVOKE DELETE ON TABLE public.ai_reports FROM authenticated;
