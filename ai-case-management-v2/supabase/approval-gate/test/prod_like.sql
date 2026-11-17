-- 운영 DB(실측)와 같은 규칙을 흉내 낸 시험용 스키마
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create type public.app_role as enum ('admin','member','viewer');

create table public.organizations(
  id uuid primary key default gen_random_uuid(), name text not null, slug text, join_code text,
  org_type text default 'x', client_types text[] default '{}', created_by uuid, created_at timestamptz default now());
create table public.profiles(
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid references public.organizations(id), name text, email text, phone text,
  created_at timestamptz default now(), status text not null default 'approved', approval_line jsonb default '[]');
create table public.user_roles(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  role public.app_role not null, created_at timestamptz default now(), unique(user_id, org_id, role));
create table public.clients(id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id), name text);

create function public.current_org_id() returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.profiles where id = auth.uid() $$;
create function public.has_role(_user_id uuid, _org_id uuid, _role public.app_role) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id=_user_id and org_id=_org_id and role=_role) $$;

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.clients enable row level security;

-- organizations (실측)
create policy "authed creates org" on public.organizations for insert to authenticated with check (created_by = auth.uid());
create policy "member reads own org" on public.organizations for select to authenticated
  using (id = (select org_id from public.profiles where id = auth.uid()) or created_by = auth.uid());
create policy "org_update" on public.organizations for update to authenticated
  using (id = (select org_id from public.profiles where id = auth.uid()))
  with check (id = (select org_id from public.profiles where id = auth.uid()));
-- profiles (실측 6개)
create policy "authenticated read profiles" on public.profiles for select to authenticated using (true);
create policy "insert own profile" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "admin can update member status" on public.profiles for update to authenticated
  using (org_id is not null and org_id in (select org_id from public.user_roles where user_id = auth.uid() and role = 'admin'))
  with check (true);
create policy "profiles_update" on public.profiles for update to authenticated
  using ((id = auth.uid()) or (org_id = (select p2.org_id from public.profiles p2 where p2.id = auth.uid())))
  with check ((id = auth.uid()) or (org_id is null) or (org_id = (select p2.org_id from public.profiles p2 where p2.id = auth.uid())));
create policy "update own profile" on public.profiles for update to authenticated
  using (id = auth.uid())
  with check ((id = auth.uid()) and (org_id is null or org_id = public.current_org_id() or public.current_org_id() is null));
create policy "users can update own profile" on public.profiles for update to authenticated
  using (id = auth.uid())
  with check ((id = auth.uid()) and (org_id is null or org_id = public.current_org_id() or public.current_org_id() is null));
-- user_roles (실측: 관리자 확인 없음)
create policy "ur_select" on public.user_roles for select to authenticated using (org_id = (select org_id from public.profiles where id = auth.uid()));
create policy "ur_insert" on public.user_roles for insert to authenticated with check (org_id = (select org_id from public.profiles where id = auth.uid()));
create policy "ur_delete" on public.user_roles for delete to authenticated using (org_id = (select org_id from public.profiles where id = auth.uid()));
-- 데이터 테이블: current_org_id() 사용
create policy "org clients" on public.clients for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id());

grant select, insert, update, delete on public.organizations, public.profiles, public.user_roles, public.clients to authenticated;
grant all on all tables in schema public to service_role;
grant execute on function public.current_org_id() to authenticated;

-- assign_org_role (저장소 원본)
create function public.assign_org_role() returns trigger language plpgsql security definer set search_path = public as $$
declare _has_admin boolean;
begin
  if new.org_id is null then return new; end if;
  if tg_op='UPDATE' and old.org_id is not distinct from new.org_id then return new; end if;
  select exists(select 1 from public.user_roles where org_id=new.org_id and role='admin') into _has_admin;
  insert into public.user_roles(user_id, org_id, role)
  values (new.id, new.org_id, case when _has_admin then 'member'::public.app_role else 'admin'::public.app_role end)
  on conflict do nothing;
  return new;
end $$;
create trigger profiles_assign_role after insert or update of org_id on public.profiles for each row execute function public.assign_org_role();

-- join_org_by_code (저장소 원본 + 이미 소속이면 오류)
create function public.join_org_by_code(_code text) returns table (id uuid, name text, org_type text, client_types text[])
language plpgsql security definer set search_path = public as $$
declare _uid uuid := auth.uid(); _org record;
begin
  if _uid is null then raise exception 'not authenticated'; end if;
  if (select p.org_id from public.profiles p where p.id=_uid) is not null then raise exception '이미 기관에 소속'; end if;
  select o.id, o.name, o.org_type, o.client_types into _org from public.organizations o where upper(o.join_code)=upper(trim(_code)) limit 1;
  if _org.id is null then raise exception '기관 코드를 찾을 수 없습니다.'; end if;
  update public.profiles set org_id=_org.id where profiles.id=_uid;
  return query select _org.id, _org.name, _org.org_type, _org.client_types;
end $$;
grant execute on function public.join_org_by_code(text) to authenticated;

-- remove_org_member (저장소 원본)
create function public.remove_org_member(target uuid) returns void language plpgsql security definer set search_path = public as $$
declare caller_org uuid; target_org uuid;
begin
  select org_id into caller_org from public.profiles where id = auth.uid();
  select org_id into target_org from public.profiles where id = target;
  if caller_org is null then raise exception '기관 정보가 없습니다.'; end if;
  if not public.has_role(auth.uid(), caller_org, 'admin') then raise exception '관리자만'; end if;
  if target = auth.uid() then raise exception '본인은 내보낼 수 없습니다.'; end if;
  if target_org is distinct from caller_org then raise exception '같은 기관만'; end if;
  update public.profiles set org_id = null where id = target;
  delete from public.user_roles where user_id = target and org_id = caller_org;
end $$;
grant execute on function public.remove_org_member(uuid) to authenticated;
