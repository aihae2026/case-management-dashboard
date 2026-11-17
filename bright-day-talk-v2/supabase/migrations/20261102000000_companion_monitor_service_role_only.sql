-- 복순이 모니터링 RPC 를 service_role 전용으로 제한한다.
-- 이전에는 anon/authenticated(공개 키)로도 호출할 수 있어, 비밀값이 새면 누구나 대화를 읽을 수 있었다.
-- 이제 사례관리 쪽 서버 함수(companion-proxy)가 service_role 키로만 호출한다.
--
-- ⚠ 적용 순서: 사례관리 쪽 companion-proxy 를 service_role 키로 호출하도록 먼저 배포한 뒤
--   이 파일을 실행한다. 순서가 반대이면 모니터링 화면이 멈춘다.
revoke all on function public.companion_monitor_list(text, text) from public, anon, authenticated;
grant execute on function public.companion_monitor_list(text, text) to service_role;
revoke all on function public.companion_monitor_detail(text, text, text) from public, anon, authenticated;
grant execute on function public.companion_monitor_detail(text, text, text) to service_role;
