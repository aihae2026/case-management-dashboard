-- ============================================================================
-- 뷰어(조회 전용) 권한 · 운영 점검 (데이터 변경 없음)
--   실제 멤버 한 명을 '뷰어'로 위장시켜 읽기/쓰기를 시도해 보고, 막혔는지 PASS/FAIL 로 보여 줍니다.
--   각 시도는 마지막에 항상 롤백되어 DB 에는 아무것도 남지 않습니다(역할 변경도 롤백).
--   Supabase SQL Editor 에 통째로 붙여넣고 Run. 마지막에 나오는 표만 보면 됩니다.
--   사전 조건: 20261009000000_add_viewer_role_value.sql, 20261009000100_viewer_read_only.sql 을 먼저 실행.
-- ============================================================================

create or replace function pg_temp.vw_try(_actor uuid, _as_viewer boolean, _sql text, _check text default null)
returns text language plpgsql as $f$
declare n bigint; chk text; res text; _org uuid;
begin
  begin
    if _as_viewer then   -- 이 시도 안에서만 뷰어로 바꿈 (끝나면 롤백)
      select org_id into _org from public.profiles where id = _actor;
      delete from public.user_roles where user_id = _actor and org_id = _org;
      insert into public.user_roles(user_id, org_id, role) values (_actor, _org, 'viewer');
    end if;
    perform set_config('request.jwt.claim.sub', _actor::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', _actor, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    execute _sql;
    get diagnostics n = row_count;
    if _check is not null then execute _check into chk; end if;
    res := 'ALLOWED rows=' || n || coalesce(' / ' || chk, '');
    raise exception '__rollback__';
  exception when others then
    if sqlerrm = '__rollback__' then return res; end if;
    return 'BLOCKED: ' || sqlerrm;
  end;
end $f$;

with
m as (  -- 시험용 멤버: 승인됨 + 관리자가 아님 + 기관에 대상자가 있음
  select p.id, p.org_id from public.profiles p
  where p.status = 'approved' and p.org_id is not null
    and not exists (select 1 from public.user_roles r where r.user_id = p.id and r.org_id = p.org_id and r.role::text = 'admin')
    and exists (select 1 from public.clients c where c.org_id = p.org_id)
  order by p.created_at limit 1),
a as (  -- 시험용 관리자 (같은 기관)
  select r.user_id id from public.user_roles r, m where r.org_id = m.org_id and r.role::text = 'admin' limit 1),
c as (
  select (select id from m) mid, (select org_id from m) morg, (select id from a) aid,
         (select id from public.clients where org_id = (select org_id from m) limit 1) cid,
         (select id from public.audit_log where op = 'DELETE' and reverted_at is null and org_id = (select org_id from m) limit 1) del_id),
t(ord, name, expect, res) as materialized (
  select 1, '뷰어가 대상자 목록 읽기', 'allow',
    case when c.mid is null then 'SKIP' else pg_temp.vw_try(c.mid, true, 'select * from public.clients') end from c
  union all
  select 2, '뷰어가 상담 기록 입력', 'block',
    case when c.mid is null or c.cid is null then 'SKIP' else pg_temp.vw_try(c.mid, true,
      format('insert into public.activity_logs(client_id, org_id, note, method, worker_name) values (%L, %L, ''뷰어 시험'', ''전화'', ''x'')', c.cid, c.morg)) end from c
  union all
  select 3, '뷰어가 대상자 정보 수정', 'block',
    case when c.mid is null or c.cid is null then 'SKIP' else pg_temp.vw_try(c.mid, true,
      format('update public.clients set name = name where id = %L', c.cid)) end from c
  union all
  select 4, '뷰어가 대상자 삭제', 'block',
    case when c.mid is null or c.cid is null then 'SKIP' else pg_temp.vw_try(c.mid, true,
      format('delete from public.clients where id = %L', c.cid)) end from c
  union all
  select 5, '뷰어가 새 대상자 등록', 'block',
    case when c.mid is null then 'SKIP' else pg_temp.vw_try(c.mid, true,
      format('insert into public.clients(org_id, name, type) values (%L, ''뷰어시험'', ''사례관리'')', c.morg)) end from c
  union all
  select 6, '뷰어가 서비스 제공 이력 입력', 'block',
    case when c.mid is null or c.cid is null then 'SKIP' else pg_temp.vw_try(c.mid, true,
      format('insert into public.provisions(client_id, org_id, category, title) values (%L, %L, ''물품'', ''뷰어 시험'')', c.cid, c.morg)) end from c
  union all
  select 7, '뷰어가 휴지통 복구(함수) 실행', 'block',
    case when c.mid is null or c.del_id is null then 'SKIP' else pg_temp.vw_try(c.mid, true,
      format('select public.restore_deleted(%L)', c.del_id)) end from c
  union all
  select 8, '뷰어가 대상자 세부 정보 저장(patch_client_extra 함수)', 'block',
    case when c.mid is null or c.cid is null then 'SKIP' else pg_temp.vw_try(c.mid, true,
      format('select public.patch_client_extra(p_id := %L, p_household := ''시험'')', c.cid),
      format('select coalesce(household = ''시험'', false)::text from public.clients where id = %L', c.cid)) end from c
  union all
  select 9, '뷰어가 접속 기록 남기기(로그인 때 자동)', 'allow',
    case when c.mid is null then 'SKIP' else pg_temp.vw_try(c.mid, true,
      format('insert into public.access_log(org_id, user_id, action) values (%L, %L, ''시험'')', c.morg, c.mid)) end from c
  union all
  select 10, '뷰어가 본인 프로필 수정', 'allow',
    case when c.mid is null then 'SKIP' else pg_temp.vw_try(c.mid, true,
      format('update public.profiles set name = name where id = %L', c.mid)) end from c
  union all
  select 11, '일반 멤버가 상담 기록 입력 (회귀 확인)', 'allow',
    case when c.mid is null or c.cid is null then 'SKIP' else pg_temp.vw_try(c.mid, false,
      format('insert into public.activity_logs(client_id, org_id, note, method, worker_name) values (%L, %L, ''멤버 시험'', ''전화'', ''x'')', c.cid, c.morg)) end from c
  union all
  select 12, '일반 멤버가 대상자 수정 (회귀 확인)', 'allow',
    case when c.mid is null or c.cid is null then 'SKIP' else pg_temp.vw_try(c.mid, false,
      format('update public.clients set name = name where id = %L', c.cid)) end from c
  union all
  select 13, '관리자가 상담 기록 입력 (회귀 확인)', 'allow',
    case when c.aid is null or c.cid is null then 'SKIP' else pg_temp.vw_try(c.aid, false,
      format('insert into public.activity_logs(client_id, org_id, note, method, worker_name) values (%L, %L, ''관리자 시험'', ''전화'', ''x'')', c.cid, c.morg)) end from c
)
select ord as 번호, name as 시험, expect as 기대, res as 결과,
  case
    when res = 'SKIP' then 'SKIP (시험할 계정·데이터 없음)'
    when expect = 'block' and (res like 'BLOCKED%' or res like 'ALLOWED rows=0%' or res like '% / false') then 'PASS'
    when expect = 'allow' and res like 'ALLOWED%' and res not like 'ALLOWED rows=0%' then 'PASS'
    when expect = 'allow' and res like 'ALLOWED rows=0%' and name like '%읽기%' then 'PASS (대상자 없음)'
    else 'FAIL' end as 판정
from t order by ord;
