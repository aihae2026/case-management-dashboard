-- 통합사례관리 → 복순이(말벗) "읽기 전용" 모니터링 RPC.
-- 이 함수는 복순이 DB(seniors, chat_messages)를 SELECT 만 한다. INSERT/UPDATE/DELETE 없음.
--   → 사례관리 앱이 복순이 대화를 수정하는 것은 구조적으로 불가능(챗봇 동작·데이터 불변).
-- 인증: 인자 p_secret 이 아래 공유 시크릿과 일치해야 하고, p_org_code(기관코드)로 범위를 제한한다.
--   → 요청자는 자기 기관코드로만 조회 가능(사례관리 앱은 로그인 기관의 join_code 만 전달).
-- SECURITY DEFINER: 소유자 권한으로 RLS(서버 전용 정책)를 우회해 읽되, 시크릿+기관코드로 보호.

-- ── 1) 목록 + 통계 (위험 분류는 사례관리 앱에서 recent_user_text 로 수행) ──
create or replace function public.companion_monitor_list(
  p_secret text,
  p_org_code text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- 사례관리 앱의 COMPANION_MONITOR_SECRET 과 반드시 같은 값이어야 한다.
  v_secret constant text := '<COMPANION_MONITOR_SECRET을_여기에_입력>';
  v_items jsonb;
begin
  -- 설치자가 비밀값을 정하지 않았으면(자리표시자 그대로) 동작하지 않는다.
  if v_secret like '<%>' then
    return jsonb_build_object('ok', false, 'reason', 'secret_not_configured');
  end if;
  if p_secret is null or p_secret <> v_secret then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;
  if coalesce(btrim(p_org_code), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.last_active_at desc), '[]'::jsonb)
    into v_items
  from (
    select
      s.session_id,
      s.name,
      (s.care_client_id is not null) as verified,
      s.care_client_id,
      s.last_active_at,
      s.created_at,
      (select count(*) from chat_messages m where m.session_id = s.session_id) as msg_count,
      (select count(*) from chat_messages m
         where m.session_id = s.session_id and m.role = 'user') as user_msg_count,
      (select m.content from chat_messages m
         where m.session_id = s.session_id and m.role = 'user'
         order by m.created_at desc limit 1) as last_user_message,
      (select left(string_agg(t.content, ' ⏎ '), 4000)
         from (
           select content from chat_messages mm
           where mm.session_id = s.session_id and mm.role = 'user'
           order by mm.created_at desc limit 40
         ) t) as recent_user_text
    from seniors s
    where upper(btrim(s.org_code)) = upper(btrim(p_org_code))
  ) x;

  return jsonb_build_object('ok', true, 'orgCode', upper(btrim(p_org_code)), 'items', v_items);
end;
$$;

-- ── 2) 한 어르신의 전체 대화 (요청 기관 소속 세션만) ──
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
  -- 세션이 요청 기관 소속인지 확인 (다른 기관 세션 차단)
  select name into v_name from seniors
  where session_id = p_session_id
    and upper(btrim(org_code)) = upper(btrim(p_org_code))
  limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) into v_msgs
  from (
    select role, content, created_at from chat_messages
    where session_id = p_session_id
    order by created_at asc limit 400
  ) m;

  return jsonb_build_object('ok', true, 'name', v_name, 'messages', v_msgs);
end;
$$;

-- 실행 권한: 사례관리 앱(anon/authenticated 키로 호출)에만. 시크릿+기관코드로 실질 보호.
revoke all on function public.companion_monitor_list(text, text) from public;
grant execute on function public.companion_monitor_list(text, text) to anon, authenticated;
revoke all on function public.companion_monitor_detail(text, text, text) from public;
grant execute on function public.companion_monitor_detail(text, text, text) to anon, authenticated;
