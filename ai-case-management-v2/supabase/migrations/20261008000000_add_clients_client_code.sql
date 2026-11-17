-- 대상자 고유번호 (예: JN0001)
--   접두어 = 기관 주소(slug)의 영문자 앞 2글자(대문자). 영문자가 2개 미만이면 'CM'.
--   번호 = 기관별 카운터(organizations.client_seq)를 1씩 올려 붙인다. 삭제·복원해도 번호를 재사용하지 않는다.
--   접두어는 처음 번호를 붙일 때 한 번 정해 저장한다. 이후 slug를 바꿔도 접두어는 그대로다.
--   (접두어를 바꾸려면: update organizations set client_code_prefix = 'AB' where id = '...';  새로 만드는 번호에만 적용됨)
--   기존 대상자 백필은 감사 기록(audit_log)과 수정시각(updated_at)을 건드리지 않는다. 등록일 순으로 번호를 붙인다.
-- 롤백: drop trigger if exists clients_client_code_guard on public.clients;
--       drop function if exists public.clients_client_code_guard();
--       drop index if exists public.clients_org_client_code_uq;
--       alter table public.clients drop column client_code;
--       alter table public.organizations drop column client_code_prefix, drop column client_seq;
--       drop function if exists public.format_client_code(text, integer);
--       drop function if exists public.derive_client_prefix(text);
begin;

alter table public.organizations add column if not exists client_code_prefix text;
alter table public.organizations add column if not exists client_seq integer not null default 0;
alter table public.organizations drop constraint if exists organizations_client_code_prefix_check;
alter table public.organizations add constraint organizations_client_code_prefix_check
  check (client_code_prefix is null or client_code_prefix ~ '^[A-Z]{2,4}$');

alter table public.clients add column if not exists client_code text;

-- 접두어: slug의 영문자만 뽑아 앞 2글자(대문자). 2글자가 안 되면 'CM'
create or replace function public.derive_client_prefix(_slug text) returns text
language sql immutable as $$
  select case
    when length(regexp_replace(coalesce(_slug, ''), '[^A-Za-z]', '', 'g')) >= 2
      then upper(left(regexp_replace(coalesce(_slug, ''), '[^A-Za-z]', '', 'g'), 2))
    else 'CM'
  end
$$;

-- 번호 모양: 접두어 + 4자리(9999를 넘으면 자리수 늘림)
create or replace function public.format_client_code(_prefix text, _n integer) returns text
language sql immutable as $$
  select _prefix || case when _n < 10000 then lpad(_n::text, 4, '0') else _n::text end
$$;

revoke execute on function public.derive_client_prefix(text) from public, anon, authenticated;
revoke execute on function public.format_client_code(text, integer) from public, anon, authenticated;

-- 백필 전에 기존 트리거를 치워 둔다(재실행 대비)
drop trigger if exists clients_client_code_guard on public.clients;

select set_config('audit.skip', 'on', true);

do $$
declare
  _touch boolean := exists (
    select 1 from pg_trigger where tgname = 'clients_touch' and tgrelid = 'public.clients'::regclass
  );
  r record;
begin
  if _touch then alter table public.clients disable trigger clients_touch; end if;

  update public.organizations
     set client_code_prefix = public.derive_client_prefix(slug)
   where client_code_prefix is null;

  -- 아직 번호가 없는 대상자만, 현재 카운터 다음 번호부터 등록일 순으로 붙인다(재실행해도 기존 번호 유지)
  for r in select id, client_code_prefix as p, client_seq as s from public.organizations loop
    with numbered as (
      select id, (row_number() over (order by registered_at nulls last, created_at, id))::integer + r.s as n
        from public.clients
       where org_id = r.id and client_code is null
    ), upd as (
      update public.clients c
         set client_code = public.format_client_code(r.p, numbered.n)
        from numbered
       where c.id = numbered.id
      returning 1
    )
    update public.organizations
       set client_seq = client_seq + (select count(*) from upd)::integer
     where id = r.id;
  end loop;

  if _touch then alter table public.clients enable trigger clients_touch; end if;
end $$;

select set_config('audit.skip', 'off', true);

create unique index if not exists clients_org_client_code_uq
  on public.clients (org_id, client_code) where client_code is not null;

-- 새 대상자에게 번호를 붙이고, 이후 번호가 바뀌지 않게 보정한다.
--  - INSERT: 번호가 없으면 기관 카운터로 부여(동시·일괄 등록도 카운터 행 잠금으로 순서대로).
--            이력(휴지통 복구)에 번호가 있으면 그대로 복원, 이 기능 전의 이력이라 NULL이면 새 번호 부여.
--  - UPDATE: 번호는 바뀌지 않는다(NULL로 덮어쓰기·이력 되돌리기 포함).
--  일반 사용자는 organizations를 수정할 수 없어 SECURITY DEFINER 로 실행한다.
create or replace function public.clients_client_code_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_prefix text;
  v_seq integer;
begin
  if tg_op = 'INSERT' then
    if new.client_code is null then
      update public.organizations
         set client_code_prefix = coalesce(client_code_prefix, public.derive_client_prefix(slug)),
             client_seq = client_seq + 1
       where id = new.org_id
      returning client_code_prefix, client_seq into v_prefix, v_seq;
      if found then
        new.client_code := public.format_client_code(v_prefix, v_seq);
      end if;
    end if;
  else
    new.client_code := old.client_code;
  end if;
  return new;
end $$;
revoke execute on function public.clients_client_code_guard() from public, anon, authenticated;
create trigger clients_client_code_guard before insert or update on public.clients
  for each row execute function public.clients_client_code_guard();

commit;

-- 확인용: 기관별 접두어·카운터·번호 현황
select o.name as 기관, o.client_code_prefix as 접두어, o.client_seq as 카운터,
       count(c.id) as 대상자수, count(c.client_code) as 번호있음,
       min(c.client_code) as 첫번호, max(c.client_code) as 마지막번호
  from public.organizations o
  left join public.clients c on c.org_id = o.id
 group by o.id, o.name, o.client_code_prefix, o.client_seq
 order by o.created_at;
