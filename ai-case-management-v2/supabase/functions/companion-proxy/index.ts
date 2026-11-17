import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  ...(Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  "http://localhost:8080",
];

function makeCors(req: Request) {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const cors = makeCors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    // JWT 검증
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return reply({ error: "Unauthorized" }, 401);
    const userToken = authHeader.replace("Bearer ", "");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);
    const { data: userData, error: authError } = await supabase.auth.getUser(userToken);
    if (authError || !userData?.user) return reply({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const COMPANION_URL = Deno.env.get("COMPANION_SUPABASE_URL");
    const MONITOR_SECRET = Deno.env.get("COMPANION_MONITOR_SECRET");

    if (!COMPANION_URL || !MONITOR_SECRET) {
      throw new Error("복순이 연동 환경변수 미설정");
    }

    // 요청 본문의 orgCode 는 믿지 않는다. 호출자의 프로필·기관·승인 상태를 서버가 직접 확인해 기관 코드를 정한다.
    const { action, sessionId, messageId } = await req.json();

    const userSupabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
    });
    const { data: profile } = await userSupabase
      .from("profiles")
      .select("org_id,status")
      .eq("id", userId)
      .maybeSingle();
    if (!profile?.org_id || profile.status !== "approved") {
      return reply({ ok: false, error: "승인된 기관 멤버만 사용할 수 있습니다." }, 403);
    }
    const { data: orgRow } = await userSupabase
      .from("organizations")
      .select("join_code")
      .eq("id", profile.org_id)
      .maybeSingle();
    const orgCode = (orgRow?.join_code as string | null | undefined)?.trim();
    if (!orgCode) return reply({ ok: false, error: "기관 코드를 확인할 수 없습니다." }, 403);

    // 삭제(복구 불가)는 관리자만. 화면에서도 관리자에게만 버튼이 보인다.
    const requireAdmin = async () => {
      const { data: roles } = await userSupabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .eq("org_id", profile.org_id);
      return (roles ?? []).some((r: { role: string }) => r.role === "admin");
    };

    const needServiceKey = () => {
      const key = Deno.env.get("COMPANION_SUPABASE_SERVICE_ROLE_KEY");
      if (!key) throw new Error("COMPANION_SUPABASE_SERVICE_ROLE_KEY 미설정");
      return {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      };
    };

    // ── 영구 삭제: service role key로 복순이 DB에서 직접 삭제 ──
    if (action === "delete") {
      if (!sessionId) throw new Error("sessionId 필수");
      if (!(await requireAdmin())) return reply({ ok: false, error: "관리자만 영구 삭제할 수 있습니다." }, 403);

      // org 검증: 요청자의 기관에서 숨겨진 세션인지 RLS로 확인 (다른 기관 세션 삭제 방지)
      const { data: hiddenRow } = await userSupabase
        .from("companion_hidden_sessions")
        .select("session_id")
        .eq("session_id", sessionId)
        .maybeSingle();
      if (!hiddenRow) return reply({ ok: false, error: "해당 세션을 삭제할 권한이 없습니다." }, 403);

      const serviceHeaders = needServiceKey();

      // chat_messages만 삭제 (seniors 기본 정보·org_code는 유지)
      // → 삭제 후 새로 채팅을 시작해도 org_code가 남아 있어 모니터링에 바로 나타남
      const msgRes = await fetch(
        `${COMPANION_URL}/rest/v1/chat_messages?session_id=eq.${encodeURIComponent(sessionId)}`,
        { method: "DELETE", headers: serviceHeaders },
      );
      if (!msgRes.ok) {
        const err = await msgRes.text();
        throw new Error("메시지 삭제 실패: " + err);
      }
      return reply({ ok: true });
    }

    // ── 개별 메시지 삭제 ──
    if (action === "deleteMessage") {
      if (!messageId) throw new Error("messageId 필수");
      if (!sessionId) throw new Error("sessionId 필수");
      if (!(await requireAdmin())) return reply({ ok: false, error: "관리자만 메시지를 삭제할 수 있습니다." }, 403);

      const serviceHeaders = needServiceKey();

      // 세션이 호출자 기관 소속인지 확인 (service role로 seniors 조회, org_code 일치까지 확인)
      const verifyRes = await fetch(
        `${COMPANION_URL}/rest/v1/seniors?session_id=eq.${encodeURIComponent(sessionId)}&org_code=ilike.${encodeURIComponent(orgCode)}&select=session_id`,
        { method: "GET", headers: { apikey: serviceHeaders.apikey, Authorization: serviceHeaders.Authorization } },
      );
      const rows = await verifyRes.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return reply({ ok: false, error: "해당 세션에 접근할 권한이 없습니다." }, 403);
      }

      // 개별 메시지 삭제 (session_id도 조건에 포함해 다른 세션 메시지 삭제 방지)
      const delRes = await fetch(
        `${COMPANION_URL}/rest/v1/chat_messages?id=eq.${encodeURIComponent(messageId)}&session_id=eq.${encodeURIComponent(sessionId)}`,
        { method: "DELETE", headers: serviceHeaders },
      );
      if (!delRes.ok) {
        const err = await delRes.text();
        throw new Error("메시지 삭제 실패: " + err);
      }
      return reply({ ok: true });
    }

    // ── RPC 호출 (list / detail): 서버가 정한 기관 코드로만 조회 ──
    let rpcName: string;
    let rpcArgs: Record<string, unknown>;

    if (action === "list") {
      rpcName = "companion_monitor_list";
      rpcArgs = { p_secret: MONITOR_SECRET, p_org_code: orgCode };
    } else if (action === "detail") {
      if (!sessionId) throw new Error("sessionId 필수");
      rpcName = "companion_monitor_detail";
      rpcArgs = { p_secret: MONITOR_SECRET, p_org_code: orgCode, p_session_id: sessionId };
    } else {
      throw new Error("알 수 없는 action: " + action);
    }

    // 모니터링 RPC 는 service_role 전용이다(공개 anon 키로는 호출 불가).
    const { apikey, Authorization } = needServiceKey();
    const res = await fetch(`${COMPANION_URL}/rest/v1/rpc/${rpcName}`, {
      method: "POST",
      headers: {
        apikey,
        Authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(rpcArgs),
    });

    const data = await res.json();
    return reply(data, res.status);
  } catch (err) {
    console.error("[companion-proxy]", err);
    return reply({ error: "요청을 처리하는 중 오류가 발생했습니다." }, 500);
  }
});
