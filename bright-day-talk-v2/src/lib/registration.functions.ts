import { createServerFn } from "@tanstack/react-start";
import { getRequestIP } from "@tanstack/react-start/server";
import { z } from "zod";
import type { Tables } from "@/integrations/supabase/types";

type WorkerRegRow = Tables<"worker_registrations"> & {
  last_active_at: string | null;
  short_code: string | null;
  birth_code: string | null;
  care_keywords: string[] | null;
};

// ── 보안 로그 헬퍼 ──────────────────────────────────
function getClientIp(): string | null {
  try {
    // Vercel/프록시 환경: x-forwarded-for 헤더 우선
    return getRequestIP({ xForwardedFor: true }) ?? null;
  } catch { return null; }
}

function parseDeviceHint(ua: string): string {
  if (!ua) return "";
  const lower = ua.toLowerCase();
  let icon = "💻";
  let type = "";
  let os = "";

  if (/iphone/.test(lower)) {
    icon = "📱"; type = "iPhone";
    const m = lower.match(/os (\d+)[_ ]/);
    if (m) os = ` iOS ${m[1]}`;
  } else if (/ipad/.test(lower)) {
    icon = "📱"; type = "iPad";
    const m = lower.match(/os (\d+)[_ ]/);
    if (m) os = ` iPadOS ${m[1]}`;
  } else if (/android/.test(lower)) {
    icon = "📱";
    const mv = lower.match(/android (\d+)/);
    os = mv ? ` Android ${mv[1]}` : " Android";
    const samsung = ua.match(/; (SM-[A-Z0-9]+)/);
    type = samsung ? samsung[1] : "스마트폰";
  } else if (/windows/.test(lower)) {
    icon = "💻"; type = "Windows";
    if (/windows nt 10/.test(lower)) os = " 10/11";
  } else if (/macintosh|mac os x/.test(lower)) {
    icon = "💻"; type = "Mac";
  }

  return `${icon} ${type}${os}`.trim();
}

// ──────────────────────────────────────────────
// 관리자 전용: 토큰 검증
// ──────────────────────────────────────────────
async function getAuthUser(token: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new Error("Unauthorized");
  return data.user;
}

function getAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

function assertAdmin(email: string) {
  if (!getAdminEmails().includes(email)) throw new Error("Forbidden: admin only");
}

// 승인하려는 등록과 같은 어르신(기관코드·성함·전화번호)이 이미 승인받은 세션을 찾는다.
// 승인받은 적 있는 세션 중 가장 오래된 것을 고른다. 로그인만 하고 승인받지 않은 행은 이어받을 대화가 없어서 건너뛴다.
// 없으면 null (처음 등록하는 어르신).
async function findApprovedSeniorSession(
  db: Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"],
  reg: { id: string; session_id: string; org_code: string; senior_name: string; senior_phone: string },
): Promise<{ sessionId: string; registrationId: string } | null> {
  const digits = reg.senior_phone.replace(/\D+/g, "");
  let query = db
    .from("seniors")
    .select("session_id")
    .eq("org_code", reg.org_code.trim().toUpperCase())
    .eq("name", reg.senior_name.trim())
    .neq("session_id", reg.session_id);
  if (digits) query = query.eq("phone", digits);
  const { data: candidates, error } = await query.order("created_at", { ascending: true }).limit(10);
  if (error) { console.error(error); throw new Error("db_error"); }
  const sessionIds = (candidates ?? []).map((c) => c.session_id as string);
  if (sessionIds.length === 0) return null;

  const { data: regs, error: regsErr } = await db
    .from("worker_registrations")
    .select("id, session_id")
    .in("session_id", sessionIds)
    .eq("status", "approved")
    .neq("id", reg.id);
  if (regsErr) { console.error(regsErr); throw new Error("db_error"); }
  const bySession = new Map((regs ?? []).map((r) => [r.session_id as string, r.id as string]));
  // candidates가 오래된 순이므로 그 순서대로 승인된 등록이 있는 첫 세션을 고른다
  for (const sid of sessionIds) {
    const registrationId = bySession.get(sid);
    if (registrationId) return { sessionId: sid, registrationId };
  }
  return null;
}

// ──────────────────────────────────────────────
// 어르신 기기 등록 (Google 로그인 불필요, session_id 기반)
// ──────────────────────────────────────────────
export const createRegistration = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({
      sessionId: z.string().min(1).max(100),
      orgCode: z.string().min(1).max(32),
      orgName: z.string().max(100).optional(),
      seniorName: z.string().min(1).max(40),
      seniorPhone: z.string().min(1).max(20),
      userAgent: z.string().max(512).optional(),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin;

    // 이미 등록된 경우 기존 레코드 반환
    const { data: existing } = await db
      .from("worker_registrations")
      .select("id, status, rejection_reason")
      .eq("session_id", data.sessionId)
      .maybeSingle();

    if (existing) {
      return {
        ok: true as const,
        id: existing.id as string,
        status: existing.status as "pending" | "approved" | "rejected",
        rejection_reason: (existing.rejection_reason as string | null) ?? null,
      };
    }

    // 새 등록은 서버에서도 확인한다. 화면에서 한 번 확인하지만, 서버 함수를 직접 부르면 그 확인을 건너뛸 수 있다.
    // 가짜 신청이 승인 대기 목록에 쌓이거나 관리자가 잘못 승인하는 것을 막는다.
    const { allowRequest } = await import("@/lib/rate-limit.server");
    const ip = getClientIp() ?? "unknown";
    if (!(await allowRequest({ prefix: "bdt:register", key: ip, limit: 20, window: "10m" }))) {
      throw new Error("too_many_requests");
    }
    const { verifySeniorExists } = await import("@/lib/care-link.server");
    const found = await verifySeniorExists({
      orgCode: data.orgCode,
      name: data.seniorName,
      phone: data.seniorPhone,
    });
    if (!found.ok) throw new Error(found.reason ?? "not_verified");

    const { data: reg, error } = await db
      .from("worker_registrations")
      .insert({
        session_id: data.sessionId,
        org_code: data.orgCode,
        org_name: data.orgName ?? null,
        senior_name: data.seniorName,
        senior_phone: data.seniorPhone,
        status: "pending",
      })
      .select("id, status")
      .single();

    if (error) { console.error(error); throw new Error("db_error"); }

    // 보안 정보 best-effort 저장 (컬럼이 없어도 에러 무시)
    try {
      const ip = getClientIp();
      const hint = parseDeviceHint(data.userAgent ?? "");
      if (ip || hint) {
        await db.from("worker_registrations")
          .update({ ip_address: ip ?? null, device_hint: hint || null })
          .eq("id", reg.id);
      }
    } catch { /* 컬럼 미존재 등 — 등록 자체는 항상 성공 */ }

    return {
      ok: true as const,
      id: reg.id as string,
      status: "pending" as const,
      rejection_reason: null,
    };
  });

// ──────────────────────────────────────────────
// 등록 상태 조회 (session_id 기반, 인증 불필요)
// ──────────────────────────────────────────────
export const getMyRegistration = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ sessionId: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin;

    const { data: reg, error } = await db
      .from("worker_registrations")
      .select("id, status, rejection_reason, org_code, org_name, senior_name, senior_phone, approved_at")
      .eq("session_id", data.sessionId)
      .maybeSingle();

    if (error) { console.error(error); throw new Error("db_error"); }
    return { registration: reg ?? null };
  });

// ──────────────────────────────────────────────
// 승인 대기·승인 해제 감지용: 등록 id로 상태만 돌려준다 (이름·전화번호 등은 내려주지 않음)
// 예전에는 브라우저가 이 테이블을 직접 읽었는데, 그러려면 anon이 모든 행을 읽을 수 있어야 해서 서버 경유로 바꿨다.
// 행이 없으면(삭제됨) status는 null.
// ──────────────────────────────────────────────
export const getRegistrationStatus = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ registrationId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: reg, error } = await supabaseAdmin
      .from("worker_registrations")
      .select("status, rejection_reason, session_id")
      .eq("id", data.registrationId)
      .maybeSingle();
    if (error) { console.error(error); throw new Error("db_error"); }
    const status = (reg?.status as "pending" | "approved" | "rejected" | undefined) ?? null;
    return {
      status,
      rejectionReason: (reg?.rejection_reason as string | null | undefined) ?? null,
      // 승인될 때 서버가 이 등록을 기존 어르신 세션으로 옮겨 둘 수 있어서, 승인된 경우에만 현재 세션을 알려 준다.
      sessionId: status === "approved" ? ((reg?.session_id as string | undefined) ?? null) : null,
    };
  });

// ──────────────────────────────────────────────
// 관리자: 전체 목록
// ──────────────────────────────────────────────
export const listAllRegistrations = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ token: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const user = await getAuthUser(data.token);
    assertAdmin(user.email ?? "");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin;

    const { data: list, error } = await db
      .from("worker_registrations")
      .select("id, session_id, org_code, org_name, senior_name, senior_phone, status, rejection_reason, created_at, approved_at, approved_by_email, ip_address, device_hint")
      .order("created_at", { ascending: false });

    if (error) { console.error(error); throw new Error("db_error"); }

    // seniors 테이블에서 last_active_at, short_code 병합
    const sessionIds = (list ?? []).map((r) => r.session_id).filter(Boolean);
    const lastActiveMap: Record<string, string | null> = {};
    const shortCodeMap: Record<string, string | null> = {};
    const birthCodeMap: Record<string, string | null> = {};
    const careKeywordsMap: Record<string, string[]> = {};
    if (sessionIds.length > 0) {
      const { data: srs } = await db
        .from("seniors")
        .select("session_id, last_active_at, short_code, birth_code, care_keywords")
        .in("session_id", sessionIds);
      for (const s of (srs ?? [])) {
        lastActiveMap[s.session_id as string] = (s.last_active_at as string | null) ?? null;
        shortCodeMap[s.session_id as string] = (s.short_code as string | null) ?? null;
        birthCodeMap[s.session_id as string] = (s.birth_code as string | null) ?? null;
        careKeywordsMap[s.session_id as string] = Array.isArray(s.care_keywords) ? (s.care_keywords as string[]) : [];
      }
    }

    const registrations = (list ?? []).map((r) => ({
      ...r,
      last_active_at: lastActiveMap[r.session_id as string] ?? null,
      short_code: shortCodeMap[r.session_id as string] ?? null,
      birth_code: birthCodeMap[r.session_id as string] ?? null,
      care_keywords: careKeywordsMap[r.session_id as string] ?? null,
    }));

    return { registrations: registrations as WorkerRegRow[] };
  });

// ──────────────────────────────────────────────
// 관리자: 승인
// ──────────────────────────────────────────────
export const approveRegistration = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ token: z.string(), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const user = await getAuthUser(data.token);
    assertAdmin(user.email ?? "");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin;

    const { data: reg, error: regErr } = await db
      .from("worker_registrations")
      .select("id, session_id, org_code, senior_name, senior_phone")
      .eq("id", data.id)
      .maybeSingle();
    if (regErr) { console.error(regErr); throw new Error("db_error"); }
    if (!reg) throw new Error("not_found");

    // 같은 어르신이 이전에 승인받은 기기(세션)가 있으면, 그 세션을 이 등록이 이어받게 한다.
    // 승인 확인·채팅·읽어 주기가 모두 "이 등록 하나"를 기준으로 돌아가고, 대화 기록도 이어진다.
    const canonicalSid = await findApprovedSeniorSession(db, reg);

    // 옛 등록은 같은 session_id를 쓸 수 없으므로(고유값) 먼저 이름을 바꿔 비켜 두고, 이 등록을 옮긴 뒤 지운다.
    // 이 등록을 저장하다 실패하면 옛 등록을 원래대로 돌려놓는다.
    let supersededId: string | null = null;
    if (canonicalSid && canonicalSid.registrationId !== reg.id) {
      supersededId = canonicalSid.registrationId;
      const { error: moveErr } = await db
        .from("worker_registrations")
        .update({ session_id: `superseded:${supersededId}` })
        .eq("id", supersededId);
      if (moveErr) { console.error(moveErr); throw new Error("db_error"); }
    }

    const { error } = await db
      .from("worker_registrations")
      .update({
        status: "approved",
        approved_at: new Date().toISOString(),
        approved_by_email: user.email ?? "",
        rejection_reason: null,
        ...(canonicalSid && supersededId ? { session_id: canonicalSid.sessionId } : {}),
      })
      .eq("id", data.id);

    if (error) {
      console.error(error);
      if (supersededId && canonicalSid) {
        const { error: undoErr } = await db
          .from("worker_registrations")
          .update({ session_id: canonicalSid.sessionId })
          .eq("id", supersededId);
        if (undoErr) console.error("[approve] 옛 등록 복구 실패:", undoErr);
      }
      throw new Error("db_error");
    }

    if (supersededId) {
      const { error: delErr } = await db.from("worker_registrations").delete().eq("id", supersededId);
      // 지우지 못해도 session_id가 바뀌어 있어서 승인 확인에는 영향이 없다 (목록에 남을 뿐)
      if (delErr) console.error("[approve] 옛 등록 삭제 실패:", delErr);
    }
    return { ok: true };
  });

// ──────────────────────────────────────────────
// 관리자: 거절
// ──────────────────────────────────────────────
export const rejectRegistration = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ token: z.string(), id: z.string().uuid(), reason: z.string().max(200).optional() }).parse(input),
  )
  .handler(async ({ data }) => {
    const user = await getAuthUser(data.token);
    assertAdmin(user.email ?? "");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin;

    const { error } = await db
      .from("worker_registrations")
      .update({ status: "rejected", rejection_reason: data.reason ?? null })
      .eq("id", data.id);

    if (error) { console.error(error); throw new Error("db_error"); }
    return { ok: true };
  });

// ──────────────────────────────────────────────
// 관리자: 승인 해제 (pending으로 되돌림)
// ──────────────────────────────────────────────
export const revokeRegistration = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ token: z.string(), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const user = await getAuthUser(data.token);
    assertAdmin(user.email ?? "");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin;

    const { error } = await db
      .from("worker_registrations")
      .update({
        status: "pending",
        approved_at: null,
        approved_by_email: null,
        rejection_reason: null,
      })
      .eq("id", data.id);

    if (error) { console.error(error); throw new Error("db_error"); }
    return { ok: true };
  });

// ──────────────────────────────────────────────
// 관리자: 등록 삭제
// ──────────────────────────────────────────────
export const deleteRegistration = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ token: z.string(), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const user = await getAuthUser(data.token);
    assertAdmin(user.email ?? "");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin;

    const { error } = await db
      .from("worker_registrations")
      .delete()
      .eq("id", data.id);

    if (error) { console.error(error); throw new Error("db_error"); }
    return { ok: true };
  });

// ──────────────────────────────────────────────
// 관리자: 대화 확인 키워드 저장 (최대 3개)
// seniors 테이블 care_keywords 컬럼 업데이트
// ──────────────────────────────────────────────
export const updateCareKeywords = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({
      token: z.string(),
      sessionId: z.string().min(1),
      keywords: z.array(z.string().max(50)).max(3),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const user = await getAuthUser(data.token);
    assertAdmin(user.email ?? "");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin;

    // 빈 문자열 제거 + 3개 초과 방지
    const cleaned = data.keywords.map((k) => k.trim()).filter(Boolean).slice(0, 3);

    const { error } = await db
      .from("seniors")
      .update({ care_keywords: cleaned })
      .eq("session_id", data.sessionId);

    if (error) { console.error(error); throw new Error("db_error"); }
    return { ok: true, keywords: cleaned };
  });

// ──────────────────────────────────────────────
// 관리자: 본인 확인
// ──────────────────────────────────────────────
export const checkIsAdmin = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ token: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const user = await getAuthUser(data.token);
    const email = user.email ?? "";
    return { isAdmin: getAdminEmails().includes(email), email };
  });
