-- 담당자 인수인계: 관리자가 이전 담당자의 대상자를 새 담당자(기관 구성원)에게 옮긴다.
-- - 바꾸는 것은 대상자의 현재 담당(clients.worker_name)뿐이다. 상담기록의 작성자(activity_logs.worker_name)는 건드리지 않아
--   이전 담당자가 쓴 기록에는 이전 담당자 이름이 그대로 남는다.
-- - 새 담당자는 같은 기관의 승인된 구성원(읽기 전용 계정 제외)만 가능하다. 이름이 아니라 계정(id)으로 받아 서버가 확인한다.
-- - 관리자 확인과 기관 확인은 화면이 아니라 이 함수 안에서 한다.

create table if not exists public.worker_handovers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  from_name text not null,
  to_name text not null,
  to_user_id uuid,
  client_ids uuid[] not null default '{}',
  moved_count int not null,
  skipped_count int not null default 0,
  note text,
  performed_by uuid,
  performed_by_name text,
  performed_at timestamptz not null default now()
);

create index if not exists worker_handovers_org_time_idx on public.worker_handovers (org_id, performed_at desc);

-- 권한: 기본 권한(자동 부여)을 먼저 걷어내고 읽기만 준다. 쓰기는 아래 함수로만 한다(수정·삭제 불가).
revoke all on public.worker_handovers from anon, authenticated;
grant select on public.worker_handovers to authenticated;
grant all on public.worker_handovers to service_role;

alter table public.worker_handovers enable row level security;

drop policy if exists "members read handovers" on public.worker_handovers;
create policy "members read handovers" on public.worker_handovers
  for select to authenticated
  using (org_id = public.current_org_id());

create or replace function public.handover_clients(
  p_from text,
  p_to_user uuid,
  p_client_ids uuid[],
  p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_caller_name text;
  v_from text := btrim(coalesce(p_from, ''));
  v_to_name text;
  v_moved uuid[];
  v_requested int;
begin
  if v_uid is null then raise exception '로그인이 필요합니다.'; end if;

  select p.org_id, p.name into v_org, v_caller_name
  from public.profiles p where p.id = v_uid and p.status = 'approved';
  if v_org is null then raise exception '승인된 기관 구성원만 사용할 수 있습니다.'; end if;

  if not exists (select 1 from public.user_roles r where r.user_id = v_uid and r.org_id = v_org and r.role = 'admin') then
    raise exception '관리자만 인수인계를 할 수 있습니다.';
  end if;

  if v_from = '' then raise exception '이전 담당자를 선택해 주세요.'; end if;
  v_requested := coalesce(array_length(p_client_ids, 1), 0);
  if v_requested = 0 then raise exception '인수인계할 대상자를 선택해 주세요.'; end if;
  if v_requested > 2000 then raise exception '한 번에 2000명까지만 옮길 수 있습니다.'; end if;

  -- 새 담당자: 같은 기관의 승인된 구성원이어야 하고, 읽기 전용 계정은 담당자가 될 수 없다.
  select btrim(p.name) into v_to_name
  from public.profiles p
  where p.id = p_to_user
    and p.org_id = v_org
    and p.status = 'approved'
    and btrim(coalesce(p.name, '')) <> ''
    and not exists (select 1 from public.user_roles r where r.user_id = p.id and r.org_id = v_org and r.role = 'viewer');
  if v_to_name is null then
    raise exception '새 담당자는 이 기관의 승인된 구성원이어야 합니다. 먼저 가입하고 승인을 받은 뒤 진행해 주세요.';
  end if;
  if v_to_name = v_from then raise exception '이전 담당자와 새 담당자가 같습니다.'; end if;

  -- 내 기관 대상자 중, 지금도 이전 담당자인 대상자만 옮긴다(그사이 담당이 바뀐 대상자·다른 기관 대상자는 건드리지 않는다).
  with moved as (
    update public.clients c
    set worker_name = v_to_name, updated_at = now()
    where c.org_id = v_org
      and c.id = any (p_client_ids)
      and btrim(coalesce(c.worker_name, '')) = v_from
    returning c.id
  )
  select coalesce(array_agg(id), '{}') into v_moved from moved;

  if coalesce(array_length(v_moved, 1), 0) = 0 then
    raise exception '옮길 대상자가 없습니다. 이미 담당이 바뀌었을 수 있으니 새로고침 후 다시 확인해 주세요.';
  end if;

  insert into public.worker_handovers
    (org_id, from_name, to_name, to_user_id, client_ids, moved_count, skipped_count, note, performed_by, performed_by_name)
  values
    (v_org, v_from, v_to_name, p_to_user, v_moved, array_length(v_moved, 1),
     v_requested - array_length(v_moved, 1), nullif(btrim(coalesce(p_note, '')), ''), v_uid, v_caller_name);

  return jsonb_build_object(
    'moved', array_length(v_moved, 1),
    'skipped', v_requested - array_length(v_moved, 1),
    'to_name', v_to_name
  );
end;
$$;

revoke all on function public.handover_clients(text, uuid, uuid[], text) from public, anon;
grant execute on function public.handover_clients(text, uuid, uuid[], text) to authenticated;
