import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** 슈퍼 관리자 이메일은 서버 환경변수 SUPER_ADMIN_EMAILS(쉼표로 구분)로 지정한다. 비어 있으면 아무도 슈퍼 관리자가 아니다. */
function superAdminEmails(): string[] {
  return (process.env.SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function assertSuperAdmin(email: string | undefined) {
  const e = (email ?? "").trim().toLowerCase();
  if (!e || !superAdminEmails().includes(e)) throw new Error("권한 없음: 슈퍼 관리자만 접근할 수 있습니다.");
}

export type OrgRow = {
  id: string;
  name: string;
  org_type: string | null;
  join_code: string | null;
  slug: string | null;
  created_at: string;
  member_count: number;
};

/** 전체 기관 목록 + 멤버 수 조회 (슈퍼 관리자 전용) */
export const getSuperAdminOrgs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as { claims: { email?: string } };
    assertSuperAdmin(ctx.claims.email);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 기관 목록
    const { data: orgs, error: orgErr } = await supabaseAdmin
      .from("organizations")
      .select("id, name, org_type, join_code, slug, created_at")
      .order("created_at", { ascending: false });
    if (orgErr) throw new Error(orgErr.message);

    // 기관별 멤버 수 (org_id 기준 count)
    const { data: counts, error: cntErr } = await supabaseAdmin
      .from("profiles")
      .select("org_id")
      .not("org_id", "is", null);
    if (cntErr) throw new Error(cntErr.message);

    const countMap: Record<string, number> = {};
    for (const p of counts ?? []) {
      if (p.org_id) countMap[p.org_id] = (countMap[p.org_id] ?? 0) + 1;
    }

    return (orgs ?? []).map((o) => ({
      ...o,
      member_count: countMap[o.id] ?? 0,
    })) as OrgRow[];
  });

/** 기관 삭제 (슈퍼 관리자 전용) — 해당 기관의 모든 DB 데이터를 순서대로 완전 삭제 */
export const deleteSuperAdminOrg = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const ctx = context as { claims: { email?: string } };
    assertSuperAdmin(ctx.claims.email);

    const { orgId } = (data as unknown) as { orgId: string };
    if (!orgId) throw new Error("orgId 누락");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 보호 기관 삭제 차단
    const { data: org } = await supabaseAdmin.from("organizations").select("name").eq("id", orgId).single();
    const protectedOrg = (process.env.ORG_NAME ?? process.env.VITE_ORG_NAME ?? "").trim();
    // 기관명 설정이 비어 있으면 어떤 기관이 보호 대상인지 알 수 없으므로 삭제를 막는다(설정 누락으로 운영 기관이 지워지는 것을 방지).
    if (!protectedOrg) throw new Error("ORG_NAME(또는 VITE_ORG_NAME)이 설정되지 않아 기관 삭제를 막았습니다. 환경변수를 지정한 뒤 다시 시도하세요.");
    if (org?.name === protectedOrg) throw new Error("보호된 기관은 삭제할 수 없습니다.");

    // ── clients 참조 자식 테이블 (FK 제약 위반 방지, clients보다 먼저 삭제) ──
    // 상담기록 (activity_logs.client_id → clients.id)
    const { error: e1 } = await supabaseAdmin.from("activity_logs").delete().eq("org_id", orgId);
    if (e1) throw new Error(`activity_logs 삭제 실패: ${e1.message}`);

    // 제공서비스 (provisions.client_id → clients.id)
    const { error: e2 } = await supabaseAdmin.from("provisions").delete().eq("org_id", orgId);
    if (e2) throw new Error(`provisions 삭제 실패: ${e2.message}`);

    // 서비스목표 (goals.client_id → clients.id)
    const { error: e3 } = await supabaseAdmin.from("goals").delete().eq("org_id", orgId);
    if (e3) throw new Error(`goals 삭제 실패: ${e3.message}`);

    // ── org_id 기반 테이블 (FK 없거나 organizations 참조) ──
    // 동의서 서명 로그
    await supabaseAdmin.from("consent_audit_logs").delete().eq("org_id", orgId);
    // 접속 로그
    await supabaseAdmin.from("access_log").delete().eq("org_id", orgId);
    // 열람 기록
    await supabaseAdmin.from("view_log").delete().eq("org_id", orgId);
    // 말벗 숨김 세션
    await supabaseAdmin.from("companion_hidden_sessions").delete().eq("org_id", orgId);
    // AI 분석 리포트
    await supabaseAdmin.from("ai_reports").delete().eq("org_id", orgId);
    // 파일
    await supabaseAdmin.from("files").delete().eq("org_id", orgId);
    // 매뉴얼 소스
    await supabaseAdmin.from("manual_sources").delete().eq("org_id", orgId);
    // 매뉴얼 (manuals_org_id_fkey)
    await supabaseAdmin.from("manuals").delete().eq("org_id", orgId);

    // ── 대상자 삭제 (위의 자식 테이블 모두 삭제 후) ──
    const { error: e4 } = await supabaseAdmin.from("clients").delete().eq("org_id", orgId);
    if (e4) throw new Error(`clients 삭제 실패: ${e4.message}`);

    // ── 감사 로그 (org_id nullable) ──
    // 감사 트리거가 삭제된 대상자 행(이름·주민번호 앞자리 등)을 DELETE 이력으로 새로 쌓으므로,
    // 반드시 clients 삭제 뒤에 지워야 이력이 남지 않는다.
    await supabaseAdmin.from("audit_log").delete().eq("org_id", orgId);

    // ── 역할 삭제 ──
    await supabaseAdmin.from("user_roles").delete().eq("org_id", orgId);

    // ── 담당자 계정 삭제 (profiles + auth.users) ──
    // profiles를 먼저 조회해서 user ID 목록 확보
    const { data: memberProfiles } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("org_id", orgId);
    const memberIds = (memberProfiles ?? []).map((p) => p.id);

    // profiles 레코드 삭제 (auth.users 삭제 전에)
    await supabaseAdmin.from("profiles").delete().eq("org_id", orgId);

    // auth.users 계정 삭제 (로그인 불가 상태로)
    // deleteUser는 throw하지 않고 { data, error }를 반환하므로 오류를 명시적으로 확인
    const deleteUserErrors: string[] = [];
    for (const userId of memberIds) {
      const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (delErr) deleteUserErrors.push(`${userId}: ${delErr.message}`);
    }
    if (deleteUserErrors.length > 0) {
      // 치명적이지 않으므로 진행하되 서버 로그에 기록 (기관·프로필은 이미 삭제됨)
      console.error("일부 auth.users 삭제 실패:", deleteUserErrors);
    }

    // ── 기관 삭제 ──
    const { error: e5 } = await supabaseAdmin.from("organizations").delete().eq("id", orgId);
    if (e5) throw new Error(`기관 삭제 실패: ${e5.message}`);

    return { ok: true, deletedUsers: memberIds.length };
  });
