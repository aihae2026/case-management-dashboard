-- 대상자별 AI 기능 활용 동의/거부
--   unset(미설정) / agree(동의) / refuse(거부). 미설정과 동의는 AI를 사용하고, 거부만 AI 기능에서 제외된다.
--   백필: 'AI 기능 동의서'를 이미 올린 대상자(consent_drive_url 있음)는 agree 로 표시한다.
--   백필은 감사 기록(audit_log)과 수정시각(updated_at)을 건드리지 않는다.
-- 롤백: drop trigger if exists clients_ai_consent_guard on public.clients;
--       drop function if exists public.clients_ai_consent_guard();
--       alter table public.clients drop column ai_consent;
begin;

alter table public.clients add column if not exists ai_consent text not null default 'unset';
alter table public.clients drop constraint if exists clients_ai_consent_check;
alter table public.clients add constraint clients_ai_consent_check
  check (ai_consent in ('unset', 'agree', 'refuse'));

select set_config('audit.skip', 'on', true);

do $$
declare _touch boolean := exists (
  select 1 from pg_trigger where tgname = 'clients_touch' and tgrelid = 'public.clients'::regclass
);
begin
  if _touch then alter table public.clients disable trigger clients_touch; end if;
  update public.clients set ai_consent = 'agree'
   where consent_drive_url is not null and ai_consent = 'unset';
  if _touch then alter table public.clients enable trigger clients_touch; end if;
end $$;

select set_config('audit.skip', 'off', true);

-- 변경 이력(audit_log)으로 복구·되돌릴 때 동의/거부 설정이 의도치 않게 바뀌지 않도록 보정한다.
--  - INSERT(휴지통 복구): 이 컬럼이 생기기 전의 이력에는 값이 없어 NULL이 들어오므로 'unset'으로.
--  - UPDATE: NULL이 오면 현재 값을 유지. 그리고 audit.skip='on'인 시스템 작업(revert_audit 등)은
--    과거 시점의 값을 다시 쓰지 못하게 현재 값을 유지한다. (앱의 정상 변경은 영향 없음)
create or replace function public.clients_ai_consent_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.ai_consent := coalesce(new.ai_consent, 'unset');
  elsif current_setting('audit.skip', true) = 'on' then
    new.ai_consent := old.ai_consent;
  else
    new.ai_consent := coalesce(new.ai_consent, old.ai_consent, 'unset');
  end if;
  return new;
end $$;
revoke execute on function public.clients_ai_consent_guard() from public, anon, authenticated;
drop trigger if exists clients_ai_consent_guard on public.clients;
create trigger clients_ai_consent_guard before insert or update on public.clients
  for each row execute function public.clients_ai_consent_guard();

commit;

select ai_consent as 상태, count(*) as 대상자수 from public.clients group by ai_consent order by 1;
