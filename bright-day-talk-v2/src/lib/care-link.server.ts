// 서버 전용: 통합사례관리(ai 프로젝트)의 "읽기 전용" DB 함수(companion_lookup RPC)를 호출한다.
// 복순이는 통합사례관리 DB에 직접 접근하지 않고, 이 RPC로 "읽기"만 요청한다(수정 경로 없음).
// 결과(케어 요약)는 복순이 자체 DB(seniors)에만 저장해 챗 근거로 쓴다.
// (이 파일은 .server.ts 이므로 서버에서만 동적 import 되며 클라이언트 번들에 포함되지 않는다.)
import { normalizePhone } from "./senior.functions";
import { describeSecret } from "./secret-fingerprint.server";
import type { TablesInsert } from "@/integrations/supabase/types";

// 통합사례관리 프로젝트 REST 주소/공개키(둘 다 공개 정보라 기본값). 공유 시크릿만 환경변수로 주입.
// 환경변수를 복사해 붙여넣을 때 끝에 공백·줄바꿈이 따라 들어가기 쉬워서 모두 앞뒤를 잘라 쓴다.
const CASE_URL = (process.env.CASE_LOOKUP_URL || "").trim();
const CASE_ANON_KEY = (process.env.CASE_LOOKUP_ANON_KEY || "").trim();
const RAW_CASE_SECRET = process.env.CASE_LOOKUP_SECRET || "";
const CASE_SECRET = RAW_CASE_SECRET.trim();
// 담당자 전화번호 조회용 (service_role key — 서버에서만 사용, 클라이언트 노출 없음)
const CASE_SERVICE_KEY = (process.env.CASE_SERVICE_ROLE_KEY || "").trim();

type CaseClient = {
  name?: string;
  birth?: string | null;
  gender?: string | null;
  worker_name?: string | null;
  grade?: string | null;
  risk?: string | null;
  needs?: string[] | null;
  housing?: string | null;
  welfare_status?: string | null;
  summary?: string | null;
  note?: string | null;
};
type CaseLog = {
  method?: string | null;
  note?: string | null;
  transcript?: string | null;
  worker_name?: string | null;
  created_at?: string | null;
};
type CaseGoal = { kind?: string | null; title?: string | null; progress?: number | null };
type CaseProvision = { category?: string | null; title?: string | null; provided_at?: string | null };
type CaseLookupResponse =
  | {
      ok: true;
      orgName: string;
      seniorName: string;
      clientId: string;
      client: CaseClient;
      logs: CaseLog[];
      goals: CaseGoal[];
      provisions: CaseProvision[];
    }
  | { ok: false; reason: string };

const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

// ── 재사정/목표분석은 clients.note 안에 구분자로 함께 저장돼 있다(ai case-types.ts와 동일 규칙). ──
const REASSESS_SEP = "\n␞재사정␞\n";
type Reassessment = {
  reassessedAt?: string;
  method?: string;
  worker?: string;
  changes?: Record<string, string>;
  scales?: Record<string, string>;
  evaluation?: { workerReview?: string; clientReview?: string; result?: string };
  workerOpinion?: string;
  result?: string;
};
function splitNote(raw: string | null): {
  note: string;
  reassessments: Reassessment[];
  goalAnalysis: { text?: string } | null;
} {
  const s = raw ?? "";
  const i = s.indexOf(REASSESS_SEP);
  if (i < 0) return { note: s, reassessments: [], goalAnalysis: null };
  const human = s.slice(0, i);
  try {
    const parsed = JSON.parse(s.slice(i + REASSESS_SEP.length));
    if (Array.isArray(parsed)) return { note: human, reassessments: parsed, goalAnalysis: null };
    if (parsed && !parsed.r && !parsed.ga)
      return { note: human, reassessments: [parsed], goalAnalysis: null };
    return { note: human, reassessments: parsed?.r ?? [], goalAnalysis: parsed?.ga ?? null };
  } catch {
    return { note: human, reassessments: [], goalAnalysis: null };
  }
}

// 사례관리 기록을 말벗이 이해하기 좋은 한글 텍스트로 요약(민감정보는 애초에 넘어오지 않음).
function buildCareContext(r: Extract<CaseLookupResponse, { ok: true }>): string {
  const c = r.client;
  const { note, reassessments, goalAnalysis } = splitNote(c.note ?? null);
  const lines: string[] = [];

  // ── 대화 포인트 (맨 위에 배치 — AI가 가장 잘 읽는 위치) ──
  // 기록에서 구체적인 화제 3~4개를 자동 추출해 제공
  const hooks: string[] = [];

  // null 방어 (RPC가 빈 배열 대신 null 반환할 수 있음)
  const logs = r.logs ?? [];
  const goals = r.goals ?? [];
  const provisions = r.provisions ?? [];

  // 최근 상담 → 그 이후 근황
  if (logs.length) {
    const l = logs[0];
    const d = (l.created_at ?? "").slice(0, 7); // YYYY-MM
    const body = clip(l.note || l.transcript || "", 60);
    if (body) hooks.push(`최근 상담(${d}): "${body}" → 그 이후 어떠신지 여쭤보기`);
    else hooks.push(`최근 상담(${d}) 이후 근황 여쭤보기`);
  }

  // 주요 욕구 → 안부 화제
  if (Array.isArray(c.needs) && c.needs.length) {
    const need = c.needs[0];
    hooks.push(`주요 욕구 "${need}" → 요즘 관련해서 불편한 점 없는지 자연스럽게 여쭤보기`);
  }

  // 진행 중 목표
  if (goals.length) {
    const g = goals.find((g) => (g.progress ?? 0) < 100) ?? goals[0];
    if (g.title) hooks.push(`목표 "${clip(g.title, 30)}" 진행 중(${g.progress ?? 0}%) → 어떻게 되어가는지 여쭤보기`);
  }

  // 최근 제공 서비스 (최대 2건 — 꾸러미·물품 등 구체적 항목은 대화 소재로 활용도 높음)
  const sortedProvisions = [...provisions].sort((a, b) =>
    (b.provided_at ?? "").localeCompare(a.provided_at ?? ""),
  );
  for (const p of sortedProvisions.slice(0, 2)) {
    const d = (p.provided_at ?? "").slice(0, 7);
    if (p.title) hooks.push(`"${clip(p.title, 40)}" 제공(${d}) → 잘 받으셨는지, 도움이 됐는지 여쭤보기`);
  }

  if (hooks.length) {
    lines.push("[💬 대화 포인트 — 이 화제들을 대화 흐름에서 자연스럽게 하나씩 꺼내봐]");
    hooks.forEach((h, i) => lines.push(`${i + 1}. ${h}`));
    lines.push("");
  }

  // ── 기본 정보 ──
  lines.push("[어르신 기본 정보]");
  lines.push(`- 성함: ${c.name ?? "-"}`);
  if (c.birth) lines.push(`- 생년: ${c.birth}`);
  if (c.gender) lines.push(`- 성별: ${c.gender}`);
  if (c.worker_name) lines.push(`- 담당 사회복지사: ${c.worker_name}`);
  if (c.grade) lines.push(`- 사례관리 구분: ${c.grade}`);
  if (c.risk) lines.push(`- 위험도: ${c.risk}`);
  if (Array.isArray(c.needs) && c.needs.length) lines.push(`- 주요 욕구: ${c.needs.join(", ")}`);
  if (c.housing) lines.push(`- 주거형태: ${c.housing}`);
  if (c.welfare_status) lines.push(`- 복지 구분: ${c.welfare_status}`);
  if (c.summary) lines.push(`- 요약: ${clip(c.summary, 400)}`);
  if (note?.trim()) lines.push(`- 사회복지사 비고: ${clip(note, 400)}`);

  // 최근 상담 7건 (날짜·요약)
  if (logs.length) {
    lines.push("\n[최근 상담 기록]");
    for (const l of logs.slice(0, 7)) {
      const d = (l.created_at ?? "").slice(0, 10);
      const body = clip(l.note || l.transcript || "", 300);
      if (body) lines.push(`- (${d}) ${body}`);
    }
  }

  // 최신 재사정 1건 핵심만
  if (reassessments.length) {
    const ra = reassessments[reassessments.length - 1];
    const head = [ra.reassessedAt, ra.method].filter(Boolean).join(" ");
    const opinion = ra.workerOpinion || ra.evaluation?.workerReview || "";
    if (head || opinion)
      lines.push(`\n[최근 재사정] ${head} ${clip(opinion, 150)}`);
  }

  // 목표 5건
  if (goals.length) {
    lines.push("\n[사례관리 목표]");
    for (const g of goals.slice(0, 5))
      lines.push(`- ${clip(g.title, 80)} (${g.progress ?? 0}%)`);
  }

  // 제공서비스 5건
  if (provisions.length) {
    lines.push("\n[최근 제공 서비스]");
    for (const p of sortedProvisions.slice(0, 5)) {
      const d = (p.provided_at ?? "").slice(0, 10);
      lines.push(`- (${d}) ${clip(p.title, 60)}`);
    }
  }

  // 전체 2800자 제한
  const full = lines.join("\n");
  return full.length > 2800 ? full.slice(0, 2800) + "…" : full;
}

// 통합사례관리 RPC를 호출해 어르신 정보를 "읽어" 온다.
async function callLookup(input: {
  orgCode: string;
  name: string;
  phone: string;
}): Promise<CaseLookupResponse> {
  if (!CASE_SECRET || !CASE_URL || !CASE_ANON_KEY) {
    // 연동 미설정 시: 검증 없이 통과 (어르신 성함·연락처를 그대로 사용)
    console.warn("[care-link] CASE_LOOKUP_* 환경변수 미설정 — 검증 없이 통과");
    return {
      ok: true,
      orgName: input.orgCode,
      seniorName: input.name,
      clientId: "",
      client: { name: input.name },
      logs: [],
      goals: [],
      provisions: [],
    };
  }
  let resp: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    resp = await fetch(`${CASE_URL}/rest/v1/rpc/companion_lookup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: CASE_ANON_KEY,
        Authorization: `Bearer ${CASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        p_join_code: input.orgCode,
        p_name: input.name,
        p_phone: input.phone,
        p_secret: CASE_SECRET,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const isTimeout = e instanceof Error && e.name === "AbortError";
    console.error("[care-link] 조회 요청 실패:", isTimeout ? "timeout (8s)" : (e instanceof Error ? e.message : e));
    return { ok: false, reason: isTimeout ? "timeout" : "network" };
  }
  clearTimeout(timer);
  const data = (await resp.json().catch(() => null)) as CaseLookupResponse | null;
  if (!data || typeof data !== "object" || !("ok" in data)) {
    console.error("[care-link] 잘못된 응답:", resp.status);
    return { ok: false, reason: "bad_response" };
  }
  // 권한 없음으로 거절되면 우리가 보낸 비밀값의 지문(길이·공백·SHA-256 앞 8글자)만 남긴다.
  // 통합사례관리 쪽에서 같은 지문을 계산해 비교하면 비밀값을 드러내지 않고 일치 여부를 알 수 있다.
  if (!data.ok && data.reason === "unauthorized") {
    console.warn(`[care-link] 비밀값 점검용 지문: ${describeSecret(RAW_CASE_SECRET)}`);
  }
  return data;
}

// 담당 복지사 전화번호 조회 결과.
// - ok: 조회 성공 (phone이 null이면 담당자 미배정 또는 번호 미등록)
// - unconfigured: 서비스 키 미설정이라 조회 자체를 하지 않음
// - failed: 네트워크·응답 오류 (이번 결과는 믿을 수 없음)
type WorkerPhoneResult = { status: "ok" | "unconfigured" | "failed"; phone: string | null };

// clientId로 담당 복지사 전화번호 조회 (service_role key로 읽기 전용 REST 호출)
async function fetchWorkerPhone(clientId: string): Promise<WorkerPhoneResult> {
  if (!CASE_SERVICE_KEY || !CASE_URL || !clientId) return { status: "unconfigured", phone: null };
  const headers = { apikey: CASE_SERVICE_KEY, Authorization: `Bearer ${CASE_SERVICE_KEY}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000); // 응답이 없으면 로그인이 멈추므로 제한
  try {
    // clients.worker_id 조회
    const clientResp = await fetch(
      `${CASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&select=worker_id&limit=1`,
      { headers, signal: controller.signal },
    );
    if (!clientResp.ok) return { status: "failed", phone: null };
    const clientRows = (await clientResp.json()) as Array<{ worker_id: string | null }>;
    const workerId = clientRows?.[0]?.worker_id;
    if (!workerId) return { status: "ok", phone: null };
    // profiles.phone 조회
    const profileResp = await fetch(
      `${CASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(workerId)}&select=phone&limit=1`,
      { headers, signal: controller.signal },
    );
    if (!profileResp.ok) return { status: "failed", phone: null };
    const profileRows = (await profileResp.json()) as Array<{ phone: string | null }>;
    return { status: "ok", phone: profileRows?.[0]?.phone ?? null };
  } catch (e) {
    console.warn("[care-link] 담당자 전화 조회 실패:", e instanceof Error ? e.message : e);
    return { status: "failed", phone: null };
  } finally {
    clearTimeout(timer);
  }
}

// 통합사례관리의 birth 문자열 → YYMMDD 6자리로 정규화
function toBirthCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 6) return digits;            // 이미 YYMMDD
  if (digits.length >= 8) return digits.slice(2, 8); // YYYYMMDD → YYMMDD
  return null;
}

// 통합사례관리에 이 어르신이 있는지 "읽기만" 한다 (저장하지 않음). 등록 요청을 서버에서 한 번 더 확인할 때 쓴다.
// 환경변수가 비어 있으면 callLookup이 통과시키므로 개발 환경에서도 등록은 된다.
export async function verifySeniorExists(input: {
  orgCode: string;
  name: string;
  phone: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const result = await callLookup({
    orgCode: input.orgCode.trim().toUpperCase(),
    name: input.name.trim(),
    phone: normalizePhone(input.phone),
  });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

// 로그인 정보로 어르신을 확인하고, 확인되면 케어 요약을 seniors 행에 저장한다.
export async function linkSeniorToCase(input: {
  sessionId: string;
  orgCode: string;
  name: string;
  phone: string;
}): Promise<{ ok: boolean; orgName?: string; seniorName?: string; reason?: string }> {
  const orgCode = input.orgCode.trim().toUpperCase();
  const name = input.name.trim();
  const phone = normalizePhone(input.phone);

  const result = await callLookup({ orgCode, name, phone });
  if (!result.ok) {
    // 통합사례관리가 돌려준 거절 이유(예: 비밀값 불일치, 대상자 없음)를 로그에 남긴다. 비밀값 자체는 남기지 않는다.
    console.warn(`[care-link] 통합사례관리 조회 거절: ${result.reason}`);
    return { ok: false, reason: result.reason };
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // 연동 환경변수가 비어 있으면 통합사례관리에서 기록을 가져온 게 아니라 "검증 없이 통과"한 것이다.
  // 이때 아래처럼 care_context를 덮어쓰면 환경변수 하나가 빠진 배포 때문에 어르신마다 저장된 케어 요약이 지워지므로,
  // 이름·전화·기관코드만 저장하고 기존 케어 요약과 담당자 정보는 그대로 둔다.
  if (!CASE_SECRET || !CASE_URL || !CASE_ANON_KEY) {
    const { error: identErr } = await supabaseAdmin.from("seniors").upsert(
      {
        session_id: input.sessionId,
        name: name || null,
        phone: phone || null,
        org_code: orgCode,
        last_active_at: new Date().toISOString(),
      },
      { onConflict: "session_id" },
    );
    if (identErr) {
      console.error("[care-link] seniors 저장 실패:", identErr.message);
      return { ok: false, reason: "store_failed" };
    }
    return { ok: true, orgName: result.orgName, seniorName: result.seniorName };
  }

  // worker_name 보존: RPC가 null 반환 시 기존 care_context에서 읽어 유지한다.
  // (ai-case-management에 담당자가 미배정인 경우에도 이미 저장된 이름을 잃지 않도록)
  if (!result.client.worker_name) {
    const { data: existing } = await supabaseAdmin
      .from("seniors")
      .select("care_context")
      .eq("session_id", input.sessionId)
      .maybeSingle();
    if (existing?.care_context) {
      const m = String(existing.care_context).match(/- 담당 사회복지사:\s*(.+)/);
      if (m?.[1]?.trim()) {
        result.client.worker_name = m[1].trim();
      }
    }
  }

  const careContext = buildCareContext(result);
  const birthCode = toBirthCode(result.client.birth);

  // 담당 복지사 전화번호: ai-case-management 건드리지 않고 REST 읽기만
  const workerPhone = await fetchWorkerPhone(result.clientId);

  // 담당자 이름과 번호는 항상 한 쌍으로 갱신한다. 담당자가 바뀌었는데 번호만 옛 담당자 것으로 남으면
  // 다른 사람 번호로 전화가 걸리기 때문이다.
  // - 조회 성공: 이름과 번호를 함께 저장 (새 담당자 번호가 없으면 옛 번호를 비움)
  // - 서비스 키 미설정: 번호를 알 수 없으니 이름만 저장하고 옛 번호는 비움
  // - 조회 실패: 이번 결과는 믿을 수 없으니 둘 다 건드리지 않음 (다음 동기화 때 다시 시도)
  const staffFields: Pick<TablesInsert<"seniors">, "staff_name" | "staff_phone"> = {};
  if (result.client.worker_name) {
    if (workerPhone.status === "ok") {
      staffFields.staff_name = result.client.worker_name;
      staffFields.staff_phone = workerPhone.phone;
    } else if (workerPhone.status === "unconfigured") {
      // 번호를 알 수 없으니 옛 번호는 비운다 (새 담당자 이름에 옛 담당자 번호가 붙지 않게)
      staffFields.staff_name = result.client.worker_name;
      staffFields.staff_phone = null;
    }
  }

  const upsertData: TablesInsert<"seniors"> = {
    session_id: input.sessionId,
    name: result.seniorName || name || null,
    phone: phone || null,
    org_code: orgCode,
    care_client_id: result.clientId,
    care_context: careContext,
    care_synced_at: new Date().toISOString(),
    last_active_at: new Date().toISOString(),
    // birth_code는 한 번 설정되면 덮어쓰지 않음 (null이면 기존 값 유지)
    ...(birthCode ? { birth_code: birthCode } : {}),
    // 담당 복지사 연락처 (성명은 RPC에서, 전화번호는 profiles에서)
    ...staffFields,
  };
  const { error } = await supabaseAdmin.from("seniors").upsert(
    upsertData,
    { onConflict: "session_id" },
  );
  if (error) {
    console.error("[care-link] seniors 저장 실패:", error.message);
    return { ok: false, reason: "store_failed" };
  }
  return { ok: true, orgName: result.orgName, seniorName: result.seniorName };
}

// 챗에서 근거로 쓸 케어 요약을 세션 기준으로 읽어온다(복순이 자체 DB).
export async function getCareContext(sessionId: string): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("seniors")
    .select("care_context")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) {
    console.error("[care-link] care_context 조회 실패:", error.message);
    return null;
  }
  return (data?.care_context as string | null) ?? null;
}
