import { createServerFn } from "@tanstack/react-start";

export type OrgName = { id: string; name: string };

/**
 * 로그인/회원가입 화면(인증 전)에서 쓰는 공개 기관 목록.
 * 서버에서 service_role 클라이언트로 읽으므로 RLS 정책이나 별도 DB 함수 없이 동작한다.
 * (배포 서버 환경에 SUPABASE_SERVICE_ROLE_KEY가 있으면 작동. 로컬에 키가 없으면 빈 목록 반환.)
 */
export const listOrgNames = createServerFn({ method: "POST" }).handler(async () => {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("organizations")
      .select("id,name")
      .order("name");
    if (error) return { orgs: [] as OrgName[] };
    return { orgs: (data ?? []) as OrgName[] };
  } catch {
    // 서버 환경에 service_role 키가 없을 때(예: 로컬 dev) 조용히 빈 목록 반환
    return { orgs: [] as OrgName[] };
  }
});

/**
 * 기관 참여 코드 사전 검증 (인증 없이 호출 가능).
 * 코드가 존재하면 { ok: true, orgName: "기관명" } 반환.
 * 코드가 없거나 오류 시 { ok: false, orgName: null } 반환.
 *
 * 1) supabaseAdmin(service_role)으로 직접 조회 시도
 * 2) SUPABASE_SERVICE_ROLE_KEY 미설정 등으로 실패 시 → anon RPC(verify_join_code) 폴백
 */
export const verifyJoinCode = createServerFn({ method: "POST" })
  .validator((data: { code: string }) => data)
  .handler(async ({ data }) => {
    const code = String(data.code ?? "").trim();
    // 가입코드는 영문·숫자만이다. '%'·'_' 같은 와일드카드가 들어간 값은 ilike 로 코드를 한 글자씩 추측하는 데 쓰일 수 있어 조회 전에 거절한다.
    if (!/^[A-Za-z0-9]{4,32}$/.test(code)) return { ok: false, orgName: null as string | null };

    // 1) Admin 클라이언트 경로 (RLS 우회, 서비스 롤 키 필요)
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: org, error } = await supabaseAdmin
        .from("organizations")
        .select("id,name")
        .ilike("join_code", code)
        .maybeSingle();
      if (!error && org) return { ok: true, orgName: org.name as string | null };
      if (!error && !org) return { ok: false, orgName: null as string | null };
      // error 있으면 아래 폴백으로 진행
      console.error("[verifyJoinCode] admin query error:", error?.message);
    } catch (e) {
      // 서비스 롤 키 미설정 등 → 폴백 사용
      console.warn("[verifyJoinCode] admin client unavailable, using RPC fallback:", (e as Error).message);
    }

    // 2) Anon 클라이언트 폴백: verify_join_code RPC (SECURITY DEFINER, anon 호출 가능)
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const url = process.env.SUPABASE_URL ?? "";
      const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
      if (!url || !key) return { ok: false, orgName: null as string | null };
      const anonClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data: orgName, error: rpcErr } = await anonClient.rpc(
        "verify_join_code" as Parameters<typeof anonClient.rpc>[0],
        { _code: code },
      );
      if (rpcErr) {
        console.error("[verifyJoinCode] RPC error:", rpcErr.message);
        return { ok: false, orgName: null as string | null };
      }
      if (orgName) return { ok: true, orgName: orgName as string };
      return { ok: false, orgName: null as string | null };
    } catch (e2) {
      console.error("[verifyJoinCode] RPC fallback failed:", (e2 as Error).message);
      return { ok: false, orgName: null as string | null };
    }
  });
