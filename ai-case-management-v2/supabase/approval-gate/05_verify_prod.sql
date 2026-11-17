-- ============================================================================
-- 승인 게이트 · 운영 점검 (데이터 변경 없음)
--   일반 멤버·대기 계정으로 위장해 "기관 변경 / 관리자 권한 획득 / 승인 / 데이터 접근"을
--   실제로 시도해 보고, 막혔는지 PASS/FAIL 로 보여 줍니다.
--   각 시도는 마지막에 항상 롤백되어 DB 에는 아무것도 남지 않습니다.
--   Supabase SQL Editor 에 통째로 붙여넣고 Run. 마지막에 나오는 표만 보면 됩니다.
-- ============================================================================

create or replace function pg_temp.gt_try(_actor uuid, _sql text, _check text default null)
returns text language plpgsql as $f$
declare n bigint; chk text; res text;
begin
  begin
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
m as (  -- 시험용 일반 멤버: 승인됨 + 소속 기관의 관리자가 아닌 사람
  select p.id, p.org_id from public.profiles p
  where p.status = 'approved' and p.org_id is not null
    and not exists (select 1 from public.user_roles r where r.user_id = p.id and r.org_id = p.org_id and r.role = 'admin')
  order by p.created_at limit 1),
o as (  -- 다른 기관
  select x.id from public.organizations x
  where x.id <> (select org_id from m) order by x.created_at limit 1),
pd as ( -- 승인 대기 계정
  select id from public.profiles where status = 'pending' order by created_at limit 1),
c as (
  select (select id from m) mid, (select org_id from m) morg, (select id from o) oid, (select id from pd) pid),
t(ord, name, expect, res) as materialized (
  select 1, '게이트 상태 (mode=enforce, data_block=on 이어야 함)', 'info',
         (select string_agg(key || '=' || value, ', ' order by key) from guard.config where key in ('mode', 'data_block'))
  union all
  select 2, '일반 멤버가 스스로 관리자 역할 추가', 'block',
    case when c.mid is null then 'SKIP' else pg_temp.gt_try(c.mid,
      format('insert into public.user_roles(user_id, org_id, role) values (%L, %L, ''admin'')', c.mid, c.morg)) end from c
  union all
  select 3, '일반 멤버가 다른 기관으로 소속 변경', 'pending',
    case when c.mid is null or c.oid is null then 'SKIP' else pg_temp.gt_try(c.mid,
      format('update public.profiles set org_id = %L where id = %L', c.oid, c.mid),
      format('select ''status='' || status from public.profiles where id = %L', c.mid)) end from c
  union all
  select 4, '일반 멤버가 다른 기관 변경 + status=approved 동시 전송', 'pending',
    case when c.mid is null or c.oid is null then 'SKIP' else pg_temp.gt_try(c.mid,
      format('update public.profiles set org_id = %L, status = ''approved'' where id = %L', c.oid, c.mid),
      format('select ''status='' || status from public.profiles where id = %L', c.mid)) end from c
  union all
  select 5, '대기 계정이 스스로 승인(status=approved)', 'pending',
    case when c.pid is null then 'SKIP' else pg_temp.gt_try(c.pid,
      format('update public.profiles set status = ''approved'' where id = %L', c.pid),
      format('select ''status='' || status from public.profiles where id = %L', c.pid)) end from c
  union all
  select 6, '대기 계정이 다른 기관 변경 + status=approved 동시 전송', 'pending',
    case when c.pid is null or c.oid is null then 'SKIP' else pg_temp.gt_try(c.pid,
      format('update public.profiles set org_id = %L, status = ''approved'' where id = %L', c.oid, c.pid),
      format('select ''status='' || status from public.profiles where id = %L', c.pid)) end from c
  union all
  select 7, '일반 멤버가 기관명 수정', 'block',
    case when c.mid is null then 'SKIP' else pg_temp.gt_try(c.mid,
      format('update public.organizations set name = name || ''_x'' where id = %L', c.morg)) end from c
  union all
  select 8, '일반 멤버가 기관 가입코드 변경', 'block',
    case when c.mid is null then 'SKIP' else pg_temp.gt_try(c.mid,
      format('update public.organizations set join_code = ''HACK1234'' where id = %L', c.morg)) end from c
  union all
  select 9, '일반 멤버가 기관 관리자 역할 삭제', 'block',
    case when c.mid is null then 'SKIP' else pg_temp.gt_try(c.mid,
      format('delete from public.user_roles where org_id = %L and role = ''admin''', c.morg)) end from c
  union all
  select 10, '대기 계정이 대상자(clients) 조회', 'zero',
    case when c.pid is null then 'SKIP' else pg_temp.gt_try(c.pid, 'select 1',
      'select ''cnt='' || count(*) from public.clients') end from c
  union all
  select 11, '대기 계정이 대상자 1건 수정', 'block',
    case when c.pid is null then 'SKIP' else pg_temp.gt_try(c.pid,
      'update public.clients set name = name where id = (select id from public.clients limit 1)') end from c
  union all
  select 12, '대기 계정이 대상자 1건 삭제', 'block',
    case when c.pid is null then 'SKIP' else pg_temp.gt_try(c.pid,
      'delete from public.clients where id = (select id from public.clients limit 1)') end from c
  union all
  select 13, '[대조군] 일반 멤버는 자기 기관 대상자 정상 조회', 'control',
    case when c.mid is null then 'SKIP' else pg_temp.gt_try(c.mid, 'select 1',
      'select ''cnt='' || count(*) from public.clients') end from c
),
v as (
  select ord, name, res,
    case
      when res = 'SKIP' then 'SKIP (대상 계정 없음)'
      when expect = 'info' then '확인'
      when expect = 'block' then case when res like 'BLOCKED%' or res like 'ALLOWED rows=0%' then 'PASS' else 'FAIL' end
      when expect = 'pending' then case when res like 'BLOCKED%' or res like '%status=pending%' then 'PASS' else 'FAIL' end
      when expect = 'zero' then case when res like '%cnt=0' then 'PASS' else 'FAIL' end
      when expect = 'control' then case when res like 'BLOCKED%' or res like '%cnt=0' then 'CHECK' else 'PASS' end
    end as verdict
  from t)
select ord as 번호, name as 시험, verdict as 판정, res as 상세 from v
union all
select 99, '요약', case when count(*) filter (where verdict = 'FAIL') = 0 then 'ALL PASS' else 'FAIL ' || count(*) filter (where verdict = 'FAIL') || '건' end,
       'PASS ' || count(*) filter (where verdict = 'PASS') || ' / FAIL ' || count(*) filter (where verdict = 'FAIL') || ' / SKIP ' || count(*) filter (where verdict like 'SKIP%')
from v
order by 1;
