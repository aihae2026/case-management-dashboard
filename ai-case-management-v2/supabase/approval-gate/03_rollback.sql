-- ============================================================================
-- 승인 게이트 · 완전 원상복구
--   트리거 3개 제거 + 접근규칙(current_org_id)을 설치 전 원본 정의로 복원.
--   guard 스키마(기록)는 남겨 둡니다. 완전히 지우려면 맨 아래 주석 한 줄을 실행하세요.
-- ============================================================================
begin;

drop trigger if exists profiles_approval_guard on public.profiles;
drop trigger if exists user_roles_approval_guard on public.user_roles;
drop trigger if exists organizations_approval_guard on public.organizations;

do $$
declare t text;
begin
  for t in select tablename from pg_policies where schemaname = 'public' and policyname = 'gate_pending_block' loop
    execute format('drop policy gate_pending_block on public.%I', t);
  end loop;
end $$;
drop function if exists public.data_gate_ok();

do $$
declare _def text;
begin
  select value into _def from guard.config where key = 'orig_current_org_id_def';
  if _def is null then
    raise exception '원본 정의가 없습니다. 중단합니다 (current_org_id 는 그대로).';
  end if;
  execute _def;   -- create or replace function public.current_org_id() ... (원본)
end $$;

commit;

select '복구 완료' as 항목,
       (pg_get_functiondef('public.current_org_id()'::regprocedure) not ilike '%guard.%')::text as 원본정의로복원됨;

-- 기록까지 완전 삭제하려면(선택):  drop schema guard cascade;
