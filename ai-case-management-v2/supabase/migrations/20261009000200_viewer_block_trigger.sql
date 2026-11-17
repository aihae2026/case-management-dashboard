-- 뷰어(조회 전용) 쓰기 차단 · 2차 방어: 테이블 트리거
--   RLS 를 우회하는 함수(SECURITY DEFINER: patch_client_extra 등)로 쓰기를 해도, 테이블 단계에서 뷰어를 거부한다.
--   · 문장 단위(FOR EACH STATEMENT) 트리거라 문장당 한 번만 확인한다(행마다 확인하지 않아 부담이 적다).
--   · 호출자의 로그인 정보(auth.uid)를 쓰므로 함수 안에서 실행돼도 '누가 호출했는지'가 그대로 적용된다.
--   · 서비스 키·SQL Editor·서버 작업(auth.uid 없음)은 영향이 없다.
--   · 오류 메시지가 '조회 전용 계정은…'으로 바로 나와 화면에서도 이유를 알 수 있다.
--   20261009000100_viewer_read_only.sql 을 먼저 실행한 뒤 실행한다. 여러 번 실행해도 안전하다.
-- 롤백(필요할 때만):
--   do $$ declare r record; begin
--     for r in select event_object_table t from information_schema.triggers where trigger_schema='public' and trigger_name='viewer_block_write' group by 1 loop
--       execute format('drop trigger viewer_block_write on public.%I', r.t);
--     end loop; end $$;
begin;

create or replace function public.block_viewer_writes() returns trigger
language plpgsql as $$
begin
  if public.is_viewer() then
    raise exception '조회 전용 계정은 입력·수정·삭제를 할 수 없어요.' using errcode = '42501';
  end if;
  return null;
end $$;
revoke execute on function public.block_viewer_writes() from public, anon;

do $$
declare t text;
begin
  foreach t in array array[
    'clients', 'activity_logs', 'provisions', 'goals', 'closure_reports', 'files',
    'ai_reports', 'manuals', 'manual_sources', 'care_plan_action_links',
    'consent_audit_logs', 'companion_ack', 'companion_hidden_sessions'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists viewer_block_write on public.%I', t);
      execute format('create trigger viewer_block_write before insert or update or delete on public.%I for each statement execute function public.block_viewer_writes()', t);
    end if;
  end loop;
end $$;

commit;

select event_object_table as 테이블, count(*) as 트리거_이벤트수
from information_schema.triggers
where trigger_schema = 'public' and trigger_name = 'viewer_block_write'
group by 1 order by 1;
