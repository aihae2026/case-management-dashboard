-- companion_monitor_detail: 메시지에 id 컬럼 추가 (개별 메시지 삭제 지원)
create or replace function public.companion_monitor_detail(
  p_secret text,
  p_org_code text,
  p_session_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret constant text := '<COMPANION_MONITOR_SECRET을_여기에_입력>';
  v_name text;
  v_msgs jsonb;
begin
  -- 설치자가 비밀값을 정하지 않았으면(자리표시자 그대로) 동작하지 않는다.
  if v_secret like '<%>' then
    return jsonb_build_object('ok', false, 'reason', 'secret_not_configured');
  end if;
  if p_secret is null or p_secret <> v_secret then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;
  -- 세션이 요청 기관 소속인지 확인
  select name into v_name from seniors
  where session_id = p_session_id
    and upper(btrim(org_code)) = upper(btrim(p_org_code))
  limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) into v_msgs
  from (
    select id, role, content, created_at from chat_messages
    where session_id = p_session_id
    order by created_at asc limit 400
  ) m;

  return jsonb_build_object('ok', true, 'name', v_name, 'messages', v_msgs);
end;
$$;
