-- 복순이 위험 알림 '확인완료' 기록(companion_ack)을 기관별로 분리한다.
--   지금까지는 로그인한 사용자 누구나 모든 기관의 기록을 읽고 쓸 수 있었다(세션 ID 노출 경로).
--   · org_id 컬럼을 추가하고, 기존 행은 확인한 사람(acked_by)의 기관으로 채운다.
--   · 열려 있던 정책 3개를 지우고, 같은 기관 멤버만 읽고 쓰게 한다(companion_hidden_sessions 와 같은 방식).
--   · 채울 수 없던 행(org_id 가 비어 있음)은 읽히지 않으며, 같은 세션을 다시 '확인'하면 그 기관 소유로 바뀐다.
--   · 뷰어 차단용 제한 정책(viewer_no_*)은 그대로 둔다.
-- 적용 순서: 이 파일을 먼저 적용한 뒤 화면(CompanionMonitorTab)을 배포한다. 반대로 하면 확인 버튼이 잠시 실패한다.
-- 여러 번 실행해도 안전하다.
-- 롤백: 정책 3개를 지우고 이전 파일(20260904000000_companion_ack.sql)의 정책을 다시 만든다. org_id 컬럼은 두어도 된다.
begin;

alter table public.companion_ack
  add column if not exists org_id uuid references public.organizations(id) on delete cascade;

update public.companion_ack a
   set org_id = p.org_id
  from public.profiles p
 where a.org_id is null and a.acked_by = p.id and p.org_id is not null;

drop policy if exists "authenticated can select companion_ack" on public.companion_ack;
drop policy if exists "authenticated can insert companion_ack" on public.companion_ack;
drop policy if exists "authenticated can update companion_ack" on public.companion_ack;
drop policy if exists "org members can select companion_ack" on public.companion_ack;
drop policy if exists "org members can insert companion_ack" on public.companion_ack;
drop policy if exists "org members can update companion_ack" on public.companion_ack;

create policy "org members can select companion_ack"
  on public.companion_ack for select
  to authenticated
  using (org_id in (select org_id from public.user_roles where user_id = auth.uid()));

create policy "org members can insert companion_ack"
  on public.companion_ack for insert
  to authenticated
  with check (org_id in (select org_id from public.user_roles where user_id = auth.uid()));

create policy "org members can update companion_ack"
  on public.companion_ack for update
  to authenticated
  using (
    org_id is null
    or org_id in (select org_id from public.user_roles where user_id = auth.uid())
  )
  with check (org_id in (select org_id from public.user_roles where user_id = auth.uid()));

commit;

-- 확인용: 기관이 채워지지 않은 행 수 (0이 아니면 해당 세션을 다시 '확인'할 때까지 화면에 안 보임)
select count(*) filter (where org_id is null) as org_id_없는_행, count(*) as 전체 from public.companion_ack;
