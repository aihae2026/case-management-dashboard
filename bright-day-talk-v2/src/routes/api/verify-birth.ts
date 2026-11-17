import { createFileRoute } from "@tanstack/react-router";

// 생년월일 6자리(YYMMDD) 인증 API
// POST /api/verify-birth
//   { shortCode, birthCode }  → 해당 어르신 생년월일 확인, 맞을 때만 session_id를 돌려준다
// (생년월일만으로 어르신을 찾는 모드는 4자리 코드 없이 session_id가 나오는 길이라 제거했다)
//
// 무차별 대입을 막기 위한 제한 (Upstash 환경변수가 있을 때만 작동, 없으면 제한 없이 통과):
//   1) IP별로 10분에 30번까지 (고유번호가 달라도 합산)
//   2) 같은 IP가 같은 고유번호에서 30분 안에 5번 틀리면 그 IP는 30분 동안 그 고유번호를 시도할 수 없다
// 고유번호별로 모두 잠그지 않는 이유: 남이 일부러 틀려서 어르신 본인을 막는 일을 피하려는 것이다.

const FAIL_LIMIT = 5;
const FAIL_WINDOW_SECONDS = 30 * 60;

export const Route = createFileRoute("/api/verify-birth")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          shortCode?: unknown;
          birthCode?: unknown;
        };

        const birthCode = typeof body.birthCode === "string"
          ? body.birthCode.replace(/\D/g, "").slice(0, 6)
          : "";

        if (birthCode.length !== 6) {
          return Response.json({ ok: false, error: "invalid_birth_code" }, { status: 400 });
        }

        // 고유번호는 숫자 1~4자리만 받고 4자리로 맞춘다 ("1", "01", "0001"이 모두 같은 어르신이므로 제한도 같은 키로 센다)
        const rawCode = typeof body.shortCode === "string" ? body.shortCode.trim() : "";
        if (!rawCode) {
          // 고유번호 없이는 확인하지 않는다
          return Response.json({ ok: false, error: "short_code_required" }, { status: 400 });
        }
        if (!/^\d{1,4}$/.test(rawCode)) {
          return Response.json({ ok: false, error: "not_found" }, { status: 404 });
        }
        const shortCode = rawCode.padStart(4, "0");

        // ── 횟수 제한 ──
        const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
        const { allowRequest, failureCount, recordFailure, clearFailures } = await import("@/lib/rate-limit.server");
        if (!(await allowRequest({ prefix: "bdt:verify-ip", key: ip, limit: 30, window: "10m" }))) {
          return Response.json({ ok: false, error: "too_many_requests" }, { status: 429 });
        }
        const failKey = `bdt:verify-fail:${ip}:${shortCode}`;
        if ((await failureCount(failKey)) >= FAIL_LIMIT) {
          return Response.json({ ok: false, error: "too_many_requests" }, { status: 429 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: senior, error: seniorErr } = await supabaseAdmin
          .from("seniors")
          .select("session_id, birth_code")
          .eq("short_code", shortCode)
          .maybeSingle();

        if (seniorErr) {
          console.error("[verify-birth] DB error (short_code lookup):", seniorErr.message);
          return Response.json({ ok: false, error: "db_error" }, { status: 500 });
        }
        if (!senior) {
          return Response.json({ ok: false, error: "not_found" }, { status: 404 });
        }

        // 생년월일이 등록되지 않은 어르신은 이 방법으로 session_id를 받을 수 없다.
        // (예전에는 검증 없이 통과시켰지만, 4자리 번호만 알면 세션을 받는 길이 되어 막았다.
        //  이런 어르신은 사례관리와 한 번 동기화되면 생년월일이 채워지고, 그 전에는 담당자 승인을 거쳐 등록한다.)
        if (!senior.birth_code) {
          return Response.json({ ok: false, error: "birth_code_missing" }, { status: 403 });
        }

        if (String(senior.birth_code) !== birthCode) {
          await recordFailure(failKey, FAIL_WINDOW_SECONDS);
          return Response.json({ ok: false, error: "wrong_birth_code" }, { status: 403 });
        }

        // 생년월일을 맞게 입력한 경우에만 session_id를 내려준다
        await clearFailures(failKey);
        return Response.json({ ok: true, sessionId: senior.session_id });
      },
    },
  },
});
