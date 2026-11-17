-- 복순이 위험 알림 확인완료 기록
-- 담당자가 경고/주의/점검 어르신을 확인했음을 표시
-- last_active_at이 acked_at보다 이후면 새 메시지가 있는 것 → 경고 자동 복원

create table if not exists public.companion_ack (
  session_id  text        primary key,
  risk_level  text        not null,
  acked_by    uuid        references auth.users(id),
  acked_at    timestamptz not null default now()
);

alter table public.companion_ack enable row level security;

-- 인증된 사용자는 읽기/삽입/수정 가능 (삭제는 불필요)
create policy "authenticated can select companion_ack"
  on public.companion_ack for select
  to authenticated using (true);

create policy "authenticated can insert companion_ack"
  on public.companion_ack for insert
  to authenticated with check (true);

create policy "authenticated can update companion_ack"
  on public.companion_ack for update
  to authenticated using (true);
