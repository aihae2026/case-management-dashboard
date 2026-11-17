-- ============================================================================
-- 승인 게이트 · 보강: 승인 대기 계정의 핵심 데이터 접근 차단
--   운영 DB 의 clients 등은 current_org_id() 가 아니라 profiles 를 직접 읽는 정책을 써서,
--   data_block 스위치가 적용되지 않았습니다. 기존 정책은 그대로 두고, 같은 스위치(guard.config.data_block)에
--   연동되는 '추가 제한 정책(restrictive)'만 얹습니다. (제한 정책은 기존 정책과 AND 로 결합)
--   - data_block = off 이면 전부 통과(지금과 동일), on 이면 승인된 계정만 통과.
--   - 여러 번 실행해도 안전. 되돌리기: 맨 아래 주석 또는 03_rollback.sql
-- ============================================================================
begin;

create or replace function public.data_gate_ok() returns boolean
language sql stable security definer set search_path = public, guard as $$
  select guard.cfg('data_block') is distinct from 'on'
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'approved')
$$;
revoke execute on function public.data_gate_ok() from public, anon;
grant execute on function public.data_gate_ok() to authenticated, service_role;

do $$
declare t text;
begin
  foreach t in array array['clients','activity_logs','provisions','goals','closure_reports','files','companion_hidden_sessions'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists gate_pending_block on public.%I', t);
      execute format(
        'create policy gate_pending_block on public.%I as restrictive for all to authenticated using (public.data_gate_ok()) with check (public.data_gate_ok())',
        t);
    end if;
  end loop;
end $$;

commit;

select tablename as 적용된_테이블, policyname as 정책, permissive as 방식
from pg_policies where schemaname = 'public' and policyname = 'gate_pending_block'
order by tablename;

-- 되돌리기(필요할 때만):
--   do $$ declare t text; begin
--     for t in select tablename from pg_policies where schemaname='public' and policyname='gate_pending_block' loop
--       execute format('drop policy gate_pending_block on public.%I', t);
--     end loop; end $$;
--   drop function if exists public.data_gate_ok();
