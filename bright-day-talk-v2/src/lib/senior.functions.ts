import { createServerFn } from "@tanstack/react-start";
import { getRequestIP } from "@tanstack/react-start/server";
import { z } from "zod";
import type { TablesInsert } from "@/integrations/supabase/types";

// Normalize a Korean phone number to digits only so it can be matched with
// the case-management system's client.phone field regardless of formatting.
export function normalizePhone(raw: string): string {
  return raw.replace(/\D+/g, "");
}

// 승인된 등록의 성함·전화번호·기관코드를 이 기기 세션의 seniors 행에 저장한다.
// 이 값이 복순이와 통합사례관리를 잇는 다리라서, 클라이언트가 보낸 값은 쓰지 않고
// 승인된 등록 행(worker_registrations)의 값만 사용한다. 승인되지 않은 세션은 거부한다.
export const saveSeniorPhone = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ sessionId: z.string().min(1).max(100) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: reg, error: regErr } = await supabaseAdmin
      .from("worker_registrations")
      .select("senior_name, senior_phone, org_code")
      .eq("session_id", data.sessionId)
      .eq("status", "approved")
      .maybeSingle();
    if (regErr) throw new Error("db_error");
    if (!reg) throw new Error("not_approved");

    const digits = normalizePhone(reg.senior_phone);
    const row: TablesInsert<"seniors"> = {
      session_id: data.sessionId,
      phone: digits || null,
      name: reg.senior_name,
      org_code: reg.org_code.trim().toUpperCase(),
      last_active_at: new Date().toISOString(),
    };
    const { error } = await supabaseAdmin.from("seniors").upsert(row, { onConflict: "session_id" });
    if (error) throw new Error("db_error");
    return { ok: true as const, phone: digits };
  });

// 앱 시작 시 케어 기록 갱신 (이미 활성화된 기기용 — 환경변수 추가 후에도 기존 어르신 반영)
export const syncCareContext = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ sessionId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // 저장된 어르신 정보 조회
    const { data: senior } = await supabaseAdmin
      .from("seniors")
      .select("org_code, name, phone, care_synced_at")
      .eq("session_id", data.sessionId)
      .maybeSingle();

    // 로그에는 세션 앞 8자와 값이 있는지 여부만 남긴다 (이름·전화·비밀값은 남기지 않음)
    const sid = data.sessionId.slice(0, 8);
    if (!senior) {
      console.warn(`[care-link] 동기화 건너뜀 (${sid}): seniors 행이 없음`);
      return { ok: false, reason: "no_row" };
    }
    if (!senior.org_code || !senior.name || !senior.phone) {
      console.warn(
        `[care-link] 동기화 건너뜀 (${sid}): 필요한 값이 비어 있음 org_code=${!!senior.org_code} name=${!!senior.name} phone=${!!senior.phone}`,
      );
      return { ok: false, reason: "no_data" };
    }
    // 마지막 동기화 후 30분 이내면 스킵
    if (senior.care_synced_at) {
      const diff = Date.now() - new Date(senior.care_synced_at as string).getTime();
      if (diff < 30 * 60 * 1000) return { ok: true, skipped: true }; // 30분 캐시
    }
    const { linkSeniorToCase } = await import("./care-link.server");
    const linked = await linkSeniorToCase({
      sessionId: data.sessionId,
      orgCode: senior.org_code as string,
      name: senior.name as string,
      phone: senior.phone as string,
    });
    if (linked.ok) {
      console.log(`[care-link] 동기화 완료 (${sid})`);
    } else {
      console.warn(`[care-link] 동기화 실패 (${sid}): ${linked.reason ?? "unknown"}`);
    }
    return { ok: linked.ok, skipped: false, orgName: linked.orgName, reason: linked.reason };
  });

// short_code로 어르신 존재 여부 확인 (/:code 라우트 진입 시 사용)
// - session_id는 어떤 경우에도 내려주지 않는다. 생년월일 인증을 통과한 사람에게만 /api/verify-birth가 준다.
// - hasBirthCode: true이면 화면이 생년월일 인증을 요구한다.
// - ownsSession: 이 기기가 이미 그 어르신의 세션을 갖고 있는지 (서버에서 비교만 하고 값은 노출 안 함)
export const getSessionByCode = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        code: z.string().min(1).max(8),
        currentSessionId: z.string().max(100).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // 고유번호를 0001부터 차례로 넣어 어떤 번호가 있는지 훑는 것을 막는다 (IP별 10분에 60번)
    const { allowRequest } = await import("./rate-limit.server");
    let ip = "unknown";
    try { ip = getRequestIP({ xForwardedFor: true }) ?? "unknown"; } catch { /* 요청 정보가 없으면 unknown */ }
    if (!(await allowRequest({ prefix: "bdt:code-lookup", key: ip, limit: 60, window: "10m" }))) {
      throw new Error("too_many_requests");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: senior, error } = await supabaseAdmin
      .from("seniors")
      .select("session_id, birth_code")
      .eq("short_code", data.code.padStart(4, "0"))
      .maybeSingle();
    // 조회 실패를 "없는 코드"로 읽으면 일시적인 장애에 정상 사용자의 기억 표시가 지워진다
    if (error) throw new Error("db_error");
    const found = !!senior;
    const hasBirthCode = !!senior?.birth_code;
    return {
      found,
      hasBirthCode,
      ownsSession: found && !!data.currentSessionId && senior.session_id === data.currentSessionId,
    };
  });

// 어르신별 담당 복지사 연락처 조회 (POST: GET이면 session_id가 요청 주소에 실려 로그에 남는다)
export const getStaffContact = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ sessionId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("seniors")
      .select("staff_phone, staff_name")
      .eq("session_id", data.sessionId)
      .maybeSingle();
    const staffName  = (row?.staff_name  as string | null) ?? null;
    const staffPhone = (row?.staff_phone as string | null) ?? null;
    return { staffPhone, staffName };
  });

// 활성화된 어르신의 short_code 조회 (URL 업데이트용)
export const getShortCode = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ sessionId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: senior } = await supabaseAdmin
      .from("seniors")
      .select("short_code")
      .eq("session_id", data.sessionId)
      .maybeSingle();
    return { shortCode: (senior?.short_code as string | null) ?? null };
  });

// 로그인: 기관코드+이름+연락처가 통합사례관리에 등록된 어르신과 일치하는지 "읽어서" 확인한다.
// 일치하면 케어 요약을 세션에 연결하고 통과, 불일치면 차단한다(등록된 어르신만 사용 가능).
export const verifySeniorLogin = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        sessionId: z.string().min(1).max(100),
        orgCode: z.string().min(1).max(32),
        name: z.string().min(1).max(40),
        phone: z.string().min(1).max(32),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // 누구나 부를 수 있는 함수라서, 기관코드·이름·전화번호를 대입해 보는 데 쓰이지 않도록 IP별로 횟수를 제한한다.
    const { allowRequest } = await import("./rate-limit.server");
    let ip = "unknown";
    try { ip = getRequestIP({ xForwardedFor: true }) ?? "unknown"; } catch { /* 요청 정보가 없으면 unknown */ }
    if (!(await allowRequest({ prefix: "bdt:login", key: ip, limit: 30, window: "10m" }))) {
      return { ok: false as const, reason: "too_many_requests" };
    }
    const { linkSeniorToCase } = await import("./care-link.server");
    return await linkSeniorToCase(data);
  });
