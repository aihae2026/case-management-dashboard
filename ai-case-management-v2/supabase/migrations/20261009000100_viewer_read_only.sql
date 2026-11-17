-- 뷰어(조회 전용) 권한을 DB에서 강제한다.
--   지금까지는 화면에서 쓰기 버튼만 숨겨서, 개발자도구나 API로 직접 요청하면 뷰어도 수정·삭제·입력이 가능했다.
--   · is_viewer(): 로그인한 사람이 자기 기관에서 뷰어(관리자·멤버가 아님)인지 판정한다.
--   · 쓰기 테이블마다 '제한 정책(restrictive)'을 얹어, 뷰어의 입력·수정·삭제만 막는다. 읽기와 다른 역할은 그대로.
--   · 휴지통 복구 함수(restore_deleted)는 RLS를 우회하므로 함수 안에서도 뷰어를 막는다.
--   · 로그인 기록(access_log)과 본인 프로필 수정은 뷰어도 계속 가능해야 해서 대상에서 뺀다.
--   여러 번 실행해도 안전하다. 먼저 20261009000000_add_viewer_role_value.sql 을 실행한 뒤 이 파일을 실행한다.
-- 롤백(필요할 때만):
--   do $$ declare r record; begin
--     for r in select tablename, policyname from pg_policies where schemaname='public' and policyname like 'viewer_no_%' loop
--       execute format('drop policy %I on public.%I', r.policyname, r.tablename);
--     end loop; end $$;
--   (restore_deleted 는 20260728020000_trash_restore.sql 을 다시 실행하면 원래대로 돌아간다)
begin;

-- 뷰어 판정 (비교를 text 로 해서 enum 값이 아직 없을 때도 오류 없이 false 로 동작)
create or replace function public.is_viewer() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
           select 1 from public.user_roles r
           join public.profiles p on p.id = r.user_id and p.org_id = r.org_id
           where r.user_id = auth.uid() and r.role::text = 'viewer')
     and not exists (
           select 1 from public.user_roles r
           join public.profiles p on p.id = r.user_id and p.org_id = r.org_id
           where r.user_id = auth.uid() and r.role::text in ('admin', 'member'))
$$;
revoke execute on function public.is_viewer() from public, anon;
grant execute on function public.is_viewer() to authenticated, service_role;

-- 쓰기 테이블에 제한 정책 (기존 정책은 그대로 두고 AND 로 결합)
do $$
declare t text;
begin
  foreach t in array array[
    'clients', 'activity_logs', 'provisions', 'goals', 'closure_reports', 'files',
    'ai_reports', 'manuals', 'manual_sources', 'care_plan_action_links',
    'consent_audit_logs', 'companion_ack', 'companion_hidden_sessions'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists viewer_no_insert on public.%I', t);
      execute format('drop policy if exists viewer_no_update on public.%I', t);
      execute format('drop policy if exists viewer_no_delete on public.%I', t);
      execute format('create policy viewer_no_insert on public.%I as restrictive for insert to authenticated with check (not (select public.is_viewer()))', t);
      execute format('create policy viewer_no_update on public.%I as restrictive for update to authenticated using (not (select public.is_viewer())) with check (not (select public.is_viewer()))', t);
      execute format('create policy viewer_no_delete on public.%I as restrictive for delete to authenticated using (not (select public.is_viewer()))', t);
    end if;
  end loop;
end $$;

-- 휴지통 복구: 같은 기관 멤버는 가능, 뷰어는 불가 (기존 함수에 뷰어 확인 한 줄만 추가)
create or replace function public.restore_deleted(_audit_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  a public.audit_log;
begin
  if public.is_viewer() then raise exception '조회 전용 계정은 복구할 수 없습니다.'; end if;
  select * into a from public.audit_log where id = _audit_id;
  if a.id is null then raise exception '기록을 찾을 수 없습니다.'; end if;
  if a.op <> 'DELETE' then raise exception '삭제된 항목만 복구할 수 있습니다.'; end if;
  if a.reverted_at is not null then raise exception '이미 복구된 항목입니다.'; end if;
  if a.org_id is distinct from public.current_org_id() then
    raise exception '같은 기관의 항목만 복구할 수 있습니다.';
  end if;
  if a.table_name not in ('clients','activity_logs','provisions','goals') then
    raise exception '지원하지 않는 대상입니다: %', a.table_name;
  end if;

  perform set_config('audit.skip', 'on', true);
  execute format('insert into public.%I select * from jsonb_populate_record(null::public.%I, $1)',
                 a.table_name, a.table_name) using a.old_data;
  perform set_config('audit.skip', 'off', true);

  update public.audit_log
  set reverted_at = now(), reverted_by = auth.uid(),
      reverted_by_name = (select name from public.profiles where id = auth.uid())
  where id = _audit_id;
end; $$;
grant execute on function public.restore_deleted(uuid) to authenticated;

commit;

-- 적용 결과: 제한 정책이 걸린 테이블 목록
select tablename as 테이블, count(*) as 제한_정책수
from pg_policies where schemaname = 'public' and policyname like 'viewer_no_%'
group by tablename order by tablename;

-- 확인용: RLS 를 우회하는 함수(SECURITY DEFINER) 중 쓰기를 하는 것들. 뷰어 확인이 없는 함수가 보이면 알려 주세요.
select p.proname as 함수, p.prosecdef as 보안정의자,
       (pg_get_functiondef(p.oid) ilike '%is_viewer%') as 뷰어확인있음,
       left(regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g'), 220) as 정의_앞부분
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
  and p.proname not in ('is_viewer','current_org_id','has_role','data_gate_ok','list_org_names','verify_join_code','gen_join_code','set_join_code',
                        'derive_client_prefix','format_client_code','audit_row','touch_updated_at','clients_ai_consent_guard','clients_client_code_guard')
order by p.proname;
