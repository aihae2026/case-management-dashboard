import { createServerFn } from "@tanstack/react-start";
import { AI_CODE_RULE, AI_USE_CLIENT_CODE, aiLabel, restoreNames } from "@/lib/ai-names";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { uploadTextToDrive } from "@/lib/drive";
import { splitNote } from "@/lib/case-types";
import { assertAiAllowed, filterAiAllowed, getAiBlockedIds } from "@/lib/ai-consent";

// ── 제미나이(Gemini) 연동 ─────────────────────────────
// 키는 코드/깃에 넣지 않는다. Supabase Edge Function 'gemini'가 Deno 시크릿 GEMINI_API_KEY 를 읽어
// 제미나이를 호출하고, 서버 함수는 사용자 인증(context.supabase)으로 그 함수를 호출한다.

/** 키 미설정 신호 — 클라이언트는 이 메시지를 보고 로컬 계산으로 폴백한다. */
const NO_KEY = "GEMINI_API_KEY missing";

/** context.supabase 중 functions.invoke 만 구조적으로 필요 — 타입 최소화. */
type EdgeInvoker = {
  functions: {
    invoke: (
      name: string,
      opts: { body: unknown },
    ) => Promise<{
      data: { text?: string; error?: string; enabled?: boolean; model?: string } | null;
      error: { message: string } | null;
    }>;
  };
};


/**
 * 'gemini' Edge Function을 호출해 system+user 프롬프트의 완성 텍스트를 반환한다.
 * json:true 이면 JSON 응답 모드. 키가 없거나 오류면 에러를 던진다(호출측이 로컬로 폴백).
 */
async function geminiChat(
  sb: unknown,
  system: string,
  user: string,
  opts?: { json?: boolean; temperature?: number },
): Promise<string> {
  const { data, error } = await (sb as EdgeInvoker).functions.invoke("gemini", {
    body: { system, user, json: opts?.json, temperature: opts?.temperature },
  });
  if (error) throw new Error(error.message || "gemini invoke failed");
  if (data?.error) throw new Error(data.error); // "GEMINI_API_KEY missing" 또는 "Gemini 4xx"
  return (data?.text ?? "").trim();
}

/** 문자열에서 첫 JSON 블록을 파싱한다. JSON이 없으면 throw. */
function parseJson<T>(text: string, _fallback: T, kind: "array" | "object" = "object"): T {
  const re = kind === "array" ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const m = text.match(re);
  if (!m) throw new Error("AI가 유효한 JSON을 반환하지 않았습니다");
  return JSON.parse(m[0]) as T;
}

const clean = (arr: unknown): string[] =>
  (Array.isArray(arr) ? arr : [])
    .filter((x) => typeof x === "string" && (x as string).trim())
    .map((x) => (x as string).trim());

/** 다양한 날짜 표기를 YYYY-MM-DD로 정규화. 인식 실패 시 "". (예: "2025.3.4", "2025년 3월 4일") */
function normYmd(v: unknown): string {
  const t = String(v ?? "")
    .trim()
    .replace(/년|월/g, "-")
    .replace(/일/g, "")
    .replace(/[.\/]/g, "-")
    .replace(/\s+/g, "");
  const m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return "";
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/** AI(제미나이) 사용 가능 여부 — 'gemini' Edge Function에 핑을 보내 키 설정 여부를 확인. */
export const aiStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    try {
      const { data, error } = await (context.supabase as unknown as EdgeInvoker).functions.invoke(
        "gemini",
        { body: { ping: true } },
      );
      if (error || !data) return { enabled: false, model: "" };
      return { enabled: !!data.enabled, model: data.model ?? "" };
    } catch {
      return { enabled: false, model: "" };
    }
  });

// 복순이 대화 분석 결과 (욕구·희망사항·위험신호 등으로 구분)
export type CompanionAnalysis = {
  summary: string; // 전반 요약
  needs: string; // 욕구
  wishes: string; // 희망사항
  riskSignals: string; // 위험신호
  emotional: string; // 정서 상태
  suggestion: string; // 담당자 제안
};

/** 복순이 대화(선택 기간)를 욕구·희망사항·위험신호 등으로 구분 분석. */
export const analyzeCompanionChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const d = data as { name?: string; period?: string; transcript: string; clientId?: string };
    if (!d?.transcript || typeof d.transcript !== "string" || d.transcript.trim().length < 20)
      throw new Error("분석할 대화 내용이 부족합니다.");
    return d;
  })
  .handler(async ({ data, context }): Promise<CompanionAnalysis> => {
    await assertAiAllowed(context.supabase, data.clientId);
    const system = [
      "당신은 노인복지관 사례관리 사회복지사를 돕는 분석가입니다.",
      "어르신과 말벗 챗봇(복순이)의 대화를 근거로만 분석하고, 근거 없는 내용은 추측하지 마세요. 존댓말을 사용합니다.",
      "위험신호(riskSignals)는 자살·자해·죽음에 대한 언급, 우울·고립·무기력, 건강 악화, 학대·방임 정황 등을 구체적으로 적고, 없으면 '특이사항 없음'이라고 적습니다.",
      "반드시 아래 JSON 형식만 응답하세요:",
      "{",
      '"summary":"대화 전반의 간단 요약(2-3줄)",',
      '"needs":"어르신의 욕구(필요·도움이 필요한 것). bullet 형태로 줄바꿈",',
      '"wishes":"어르신의 희망사항·바람. bullet 형태로 줄바꿈",',
      '"riskSignals":"위험신호(구체적으로). 없으면 특이사항 없음",',
      '"emotional":"정서 상태(관찰된 기분·심리)",',
      '"suggestion":"담당 사회복지사에게 드리는 제안 1-3개. bullet"',
      "}",
    ].join("\n");
    const content = await geminiChat(
      context.supabase,
      system,
      `어르신: ${AI_USE_CLIENT_CODE ? "(이름 비공개)" : data.name || "익명"}${data.period ? ` / 기간: ${data.period}` : ""}\n\n대화 원문:\n${data.transcript.slice(0, 14000)}`,
      { json: true },
    );
    const p = parseJson<Record<string, unknown>>(content, {});
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    return {
      summary: s(p.summary),
      needs: s(p.needs),
      wishes: s(p.wishes),
      riskSignals: s(p.riskSignals),
      emotional: s(p.emotional),
      suggestion: s(p.suggestion),
    };
  });

// 재사정 AI 분석 결과 타입
export type ReassessNeedItem = {
  problem: string; // 요구 또는 드러난 문제
  need: string; // 욕구
  goal: string; // 서비스 목표
  clientAction: string; // 당사자 행동계획
  workerAction: string; // 담당자 행동계획
  priority: string; // 우선순위
  urgency: string; // 긴급성
  checkCycle: string; // 점검주기
  criteria: string; // 목표달성 기준
};
// 문서에서 추출한 재사정 메타데이터 (실시일·척도 등) — 업로드일이 아닌 문서 기준값
export type ReassessMeta = {
  reassessedAt: string; // 문서상 재사정 실시일 YYYY-MM-DD (없으면 "")
  yearNo: string; // 년차
  method: string; // 내방/방문/전화
  worker: string; // 담당 사회복지사
  result: string; // 재사정 결과
  sgdsTotal: string; // 우울척도(SGDS) 총점(숫자)
  sgdsResult: string; // 우울척도 판정
  sgdsOpinion: string; // 우울척도 의견
  mspssAgency: string; // 사회지지(MSPSS) 복지관/기관 점수
  mspssFriend: string; // MSPSS 친구 점수
  mspssOther: string; // MSPSS 가족/주변인 점수
  mspssOpinion: string; // 사회지지 의견
};
export type ReassessAnalysis = {
  ok: boolean;
  message?: string;
  meta: ReassessMeta;
  physicalChanges: string;
  psychologicalChanges: string;
  economicChanges: string;
  socialChanges: string;
  etcChanges: string;
  expressedNeeds: string;
  identifiedNeeds: string;
  problems: string;
  risks: string;
  strengths: string;
  interventionAreas: string;
  recommendedGoals: string;
  recommendedActions: string;
  priorities: string;
  needs: ReassessNeedItem[];
};

/** 재사정 기록(직접작성/ PDF 추출 텍스트)을 10개 항목으로 분석 + 서비스목표 연계용 욕구 배열 생성. */
export const analyzeReassessment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const d = data as { text: string; clientId?: string };
    if (!d?.text || typeof d.text !== "string") throw new Error("text required");
    if (d.text.trim().length < 20)
      throw new Error("분석할 재사정 내용이 부족합니다. 내용을 조금 더 입력해 주세요.");
    return d;
  })
  .handler(async ({ data, context }): Promise<ReassessAnalysis> => {
    await assertAiAllowed(context.supabase, data.clientId);
    const system = [
      "당신은 한국 노인복지관의 사례관리 슈퍼바이저입니다.",
      "아래 재사정 기록을 근거로만 분석하고, 근거 없는 내용은 추측하지 마세요. 존댓말을 사용합니다.",
      "meta의 날짜·점수는 문서에 명시된 값만 그대로 추출하고, 없으면 빈 문자열(\"\")로 두세요(추측 금지).",
      "meta.reassessedAt는 이 기록지가 '실제로 재사정을 실시한 날짜'이며 반드시 YYYY-MM-DD 형식으로 적습니다(작성일/출력일이 아니라 사정 실시일 기준).",
      "척도 점수(sgdsTotal, mspss*)는 숫자만 적습니다.",
      "반드시 아래 JSON 형식만 응답하세요:",
      "{",
      '"meta":{"reassessedAt":"재사정 실시일 YYYY-MM-DD","yearNo":"년차 숫자","method":"내방|방문|전화","worker":"담당 사회복지사","result":"재사정 결과","sgdsTotal":"SGDS 총점 숫자","sgdsResult":"SGDS 판정","sgdsOpinion":"SGDS 의견","mspssAgency":"MSPSS 복지관 점수","mspssFriend":"MSPSS 친구 점수","mspssOther":"MSPSS 가족/주변인 점수","mspssOpinion":"사회지지 의견"},',
      '"physicalChanges":"신체적 상황 변화(없으면 빈 문자열)",',
      '"psychologicalChanges":"심리·정서적 상황 변화(없으면 빈 문자열)",',
      '"economicChanges":"경제적 상황 변화(없으면 빈 문자열)",',
      '"socialChanges":"사회적 관계망 변화(없으면 빈 문자열)",',
      '"etcChanges":"기타 변화사항(없으면 빈 문자열)",',
      '"expressedNeeds":"당사자가 표현한 요구",',
      '"identifiedNeeds":"실제로 확인되는 욕구",',
      '"problems":"주요 문제",',
      '"risks":"위험요인 및 긴급성",',
      '"strengths":"강점 및 활용 가능한 자원",',
      '"interventionAreas":"서비스 개입이 필요한 영역",',
      '"recommendedGoals":"추천 욕구 목표",',
      '"recommendedActions":"추천 행동계획",',
      '"priorities":"서비스 우선순위",',
      '"needs":[{"problem":"요구 또는 드러난 문제","need":"욕구","goal":"서비스 목표","clientAction":"당사자 행동계획","workerAction":"담당자 행동계획","priority":"상|중|하","urgency":"높음|보통|낮음","checkCycle":"점검주기(예: 월 1회)","criteria":"목표달성 기준"}]',
      "}",
    ].join("\n");
    const content = await geminiChat(
      context.supabase,
      system,
      `재사정 기록:\n\n${data.text.slice(0, 15000)}`,
      { json: true },
    );
    const p = parseJson<Record<string, unknown>>(content, {});
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    // 숫자/문자 모두 문자열로 (AI가 점수를 숫자로 줄 수 있음)
    const sn = (v: unknown) =>
      typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
    const mm = (p.meta ?? {}) as Record<string, unknown>;
    const meta: ReassessMeta = {
      reassessedAt: normYmd(mm.reassessedAt),
      yearNo: sn(mm.yearNo),
      method: s(mm.method),
      worker: s(mm.worker),
      result: s(mm.result),
      sgdsTotal: sn(mm.sgdsTotal),
      sgdsResult: s(mm.sgdsResult),
      sgdsOpinion: s(mm.sgdsOpinion),
      mspssAgency: sn(mm.mspssAgency),
      mspssFriend: sn(mm.mspssFriend),
      mspssOther: sn(mm.mspssOther),
      mspssOpinion: s(mm.mspssOpinion),
    };
    const needsRaw = Array.isArray(p.needs) ? (p.needs as Record<string, unknown>[]) : [];
    const needs: ReassessNeedItem[] = needsRaw
      .map((n) => ({
        problem: s(n.problem),
        need: s(n.need),
        goal: s(n.goal),
        clientAction: s(n.clientAction),
        workerAction: s(n.workerAction),
        priority: s(n.priority),
        urgency: s(n.urgency),
        checkCycle: s(n.checkCycle),
        criteria: s(n.criteria),
      }))
      .filter((n) => n.need || n.problem || n.goal);
    return {
      ok: true,
      meta,
      physicalChanges: s(p.physicalChanges),
      psychologicalChanges: s(p.psychologicalChanges),
      economicChanges: s(p.economicChanges),
      socialChanges: s(p.socialChanges),
      etcChanges: s(p.etcChanges),
      expressedNeeds: s(p.expressedNeeds),
      identifiedNeeds: s(p.identifiedNeeds),
      problems: s(p.problems),
      risks: s(p.risks),
      strengths: s(p.strengths),
      interventionAreas: s(p.interventionAreas),
      recommendedGoals: s(p.recommendedGoals),
      recommendedActions: s(p.recommendedActions),
      priorities: s(p.priorities),
      needs,
    };
  });

/** 재사정 기록지에서 사례관리 계획서 표를 AI 추출. */
export interface CarePlanActionRaw {
  text: string;
  targetCount: number | null;
  unit: string | null;
}
export interface CarePlanRowRaw {
  priority: number;
  problem: string;
  need: string;
  selfPlan: CarePlanActionRaw[];
  workerPlan: CarePlanActionRaw[];
}
export interface CarePlanResult {
  ok: boolean;
  year?: number;
  rows?: CarePlanRowRaw[];
  error?: string;
}

export const extractCarePlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const d = data as { text: string; docType?: "intake" | "reassessment"; clientId?: string };
    if (!d?.text || typeof d.text !== "string") throw new Error("text required");
    return d;
  })
  .handler(async ({ data, context }): Promise<CarePlanResult> => {
    await assertAiAllowed(context.supabase, data.clientId);
    const isIntake = data.docType === "intake";
    const commonSuffix = [
      "각 행동계획 항목에서 횟수·수량(예: '2회', '주 1회', '월 2회', '4회')이 있으면 targetCount(숫자)와 unit('회', '개월' 등)으로 분리하세요.",
      "행동계획에서 '-' 또는 숫자 번호로 시작하는 각 세부항목을 별도 객체로 분리하세요.",
      "반드시 아래 JSON 형식만 응답하세요:",
      '{"year":2025,"rows":[{"priority":1,"problem":"요구/드러난 문제","need":"욕구","selfPlan":[{"text":"행동계획 텍스트","targetCount":2,"unit":"회"}],"workerPlan":[{"text":"행동계획 텍스트","targetCount":null,"unit":null}]}]}',
    ];
    const system = isIntake
      ? [
          "당신은 한국 노인복지관의 사례관리 전문가입니다.",
          "아래 텍스트는 신규 대상자의 적격심사지(초기 사정/욕구 조사서)입니다.",
          "문서에서 사례관리 계획에 필요한 정보를 추출해 rows 배열로 만드세요.",
          "다음 순서로 계획 항목을 찾으세요:",
          "1) '서비스 계획', '계획서', '행동계획' 등 명시적 계획 표가 있으면 그대로 추출",
          "2) 명시적 계획표가 없으면, 체크된 욕구 항목·확인된 문제·필요 서비스를 기반으로 기본 계획 항목을 생성",
          "  - 당사자 행동계획: 대상자 본인이 수행하는 내용 (없으면 '담당자 안내에 따라 서비스 이용')",
          "  - 담당자 행동계획: 사회복지사·기관이 제공·연계하는 내용",
          "문서 연도(예: '2025년', '26년')를 year로 추출하고, 없으면 현재 연도를 사용하세요.",
          ...commonSuffix,
        ].join("\n")
      : [
          "당신은 한국 노인복지관의 사례관리 전문가입니다.",
          "아래 재사정 기록지 텍스트에서 '사례관리 계획서' 표를 추출하세요.",
          "표는 '요구/드러난 문제', '욕구', '당사자 행동계획', '담당자 행동계획', '우선순위(긴급성)' 열로 구성됩니다.",
          "문서 첫 부분의 연도(예: '2025년', '26년', '2026년 재사정')를 year로 추출하세요.",
          "year가 없으면 재사정 날짜 연도에 1을 더한 값을 사용하세요.",
          ...commonSuffix,
        ].join("\n");

    const label = isIntake ? "적격심사지" : "재사정 기록지";
    try {
      const content = await geminiChat(
        context.supabase,
        system,
        `${label}:\n\n${data.text.slice(0, 15000)}`,
        { json: true },
      );
      const p = parseJson<{ year: number; rows: CarePlanRowRaw[] }>(content, {
        year: 0,
        rows: [],
      });
      if (!p.year || !Array.isArray(p.rows) || p.rows.length === 0) {
        return { ok: false, error: isIntake ? "욕구/서비스 계획 항목을 찾지 못했습니다." : "계획서 표를 찾지 못했습니다." };
      }
      return { ok: true, year: p.year, rows: p.rows };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

// ── 밑반찬 PDF 분석 ─────────────────────────────────────────────────
export interface SideDishClientInfo {
  name?: string;
  birth?: string;         // YYYY-MM-DD
  gender?: string;        // 남|여
  phone?: string;
  address?: string;       // 기본주소 (도로명·지번, 상세 제외)
  address_detail?: string;// 상세주소 (동·호수·층·지하 등)
  welfare?: string;       // 수급자|차상위|일반
  household?: string;     // 독거|부부|가족|조손|기타 (동거형태)
  housing?: string;       // 자가|전세|월세|임대|무상거주|기타 (주거형태/소유형태)
}

export interface SideDishPdfResult {
  ok: boolean;
  clientInfo?: SideDishClientInfo;
  error?: string;
}

/** 밑반찬 PDF(실태조사표+선정표+사례회의록 합본)에서 대상자 정보와 실태조사 내용을 추출. */
export const analyzeSideDishPdf = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const d = data as { text: string };
    if (!d?.text || typeof d.text !== "string") throw new Error("text required");
    if (d.text.trim().length < 20)
      throw new Error("분석할 내용이 부족합니다. PDF에 텍스트가 포함되어 있는지 확인해 주세요.");
    return d;
  })
  .handler(async ({ data, context }): Promise<SideDishPdfResult> => {
    try {
      const system = [
        "당신은 한국 노인복지관의 사회복지사입니다.",
        "아래 PDF 문서에서 대상자 기본 인적사항만 추출하여 JSON으로 응답하세요.",
        "실태조사, 선정조사표, 사례회의록 등의 내용은 추출하지 마세요. 오직 대상자 개인정보만 추출합니다.",
        "문서에 없는 정보는 빈 문자열(\"\")로 두세요. 절대 추측하지 마세요.",
        "birth는 반드시 YYYY-MM-DD 형식. 없으면 빈 문자열.",
        "welfare는 '수급자', '차상위', '일반' 중 하나(또는 문서에 나타난 표현 그대로).",
        "household(동거형태)는 '독거', '부부', '가족', '조손', '기타' 중 가장 가까운 것.",
        "housing(주거형태/소유형태)는 '자가', '전세', '월세', '임대', '무상거주', '시설거주', '기타' 중 가장 가까운 것.",
        "주소는 기본주소(address)와 상세주소(address_detail)를 반드시 분리하세요:",
        "  - address: 문서에 기재된 주소 전체를 그대로 추출하되, 반드시 시/도부터 시작해야 합니다.",
        "    예) 서울특별시 강남구 예시로112길 10 / 경기도 수원시 팔달구 효원로 1 / 서울시 노원구 공릉로 10",
        "    주소에 시/도가 없으면 앞에 있는 다른 행·필드에서 시/도를 찾아 붙여 완성된 주소로 만드세요.",
        "  - address_detail: 동·호수·층·지하·건물명 등 세부 위치(시/도·구·로 이후의 상세 부분). 예) 지하, 101호, B동 302호",
        "  - 상세주소가 없으면 address_detail은 빈 문자열.",
        "반드시 아래 JSON 형식만 응답하세요:",
        "{",
        '"clientInfo":{',
        '"name":"이름","birth":"YYYY-MM-DD","gender":"남|여","phone":"연락처","address":"기본주소","address_detail":"상세주소","welfare":"수급자|차상위|일반","household":"독거|부부|가족|조손|기타","housing":"자가|전세|월세|임대|무상거주|기타"',
        "}",
        "}",
      ].join("\n");
      const content = await geminiChat(
        context.supabase,
        system,
        `문서 내용:\n\n${data.text.slice(0, 15000)}`,
        { json: true },
      );
      const p = parseJson<Record<string, unknown>>(content, {});
      const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      const ci = (p.clientInfo ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        clientInfo: {
          name: s(ci.name),
          birth: normYmd(ci.birth),
          gender: s(ci.gender),
          phone: s(ci.phone),
          address: s(ci.address),
          address_detail: s(ci.address_detail),
          welfare: s(ci.welfare),
          household: s(ci.household),
          housing: s(ci.housing),
        },
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

// ── 실태조사 PDF 분석 (별도 함수) ───────────────────────────────────────
export interface AssessmentPdfResult {
  ok: boolean;
  assessedAt?: string;          // YYYY-MM-DD (문서 기재 조사일)
  livingCondition?: string;     // 생활 실태
  healthCondition?: string;     // 건강 실태
  mealCondition?: string;       // 급식 실태
  specialNotes?: string;        // 특이사항
  workerOpinion?: string;       // 사회복지사 의견
  selectionContent?: string;    // 선정조사표 내용
  selectionResult?: string;     // 선정 결과
  meetingContent?: string;      // 사례회의록 내용
  meetingDecision?: string;     // 결정사항
  error?: string;
}

/**
 * 밑반찬 실태조사 PDF에서 조사 내용만 추출한다.
 * 대상자 기본정보(이름·주소 등)는 추출하지 않는다.
 */
export const analyzeSideDishAssessment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const d = data as { text: string; clientId?: string };
    if (!d?.text || typeof d.text !== "string") throw new Error("text required");
    if (d.text.trim().length < 20)
      throw new Error("분석할 내용이 부족합니다. PDF에 텍스트가 포함되어 있는지 확인해 주세요.");
    return d;
  })
  .handler(async ({ data, context }): Promise<AssessmentPdfResult> => {
    await assertAiAllowed(context.supabase, data.clientId);
    try {
      const system = [
        "당신은 한국 노인복지관의 사회복지사입니다.",
        "아래 PDF 문서는 밑반찬 사업의 실태조사표, 선정조사표, 사례회의록 합본입니다.",
        "이름·생년월일·주소 등 개인정보는 추출하지 마세요. 오직 조사 내용만 추출합니다.",
        "assessedAt(조사일): 문서에 기재된 '조사일', '작성일', '실시일', '조사 날짜' 등에서 가장 적절한 날짜를 YYYY-MM-DD 형식으로 추출. 없으면 빈 문자열.",
        "각 항목은 문서에서 해당 내용을 그대로 발췌하되, 자연스럽게 정리하세요. 없으면 빈 문자열.",
        "livingCondition: 생활환경·거주실태·일상생활·주거환경 관련 내용.",
        "healthCondition: 건강상태·질환·의료·신체 기능 관련 내용.",
        "mealCondition: 식생활·영양·급식 관련 내용.",
        "specialNotes: 특이사항·특이 내용·메모.",
        "workerOpinion: 사회복지사 의견·소견·판단.",
        "selectionContent: 선정조사표 내용 (자산·소득·부양의무자 등).",
        "selectionResult: 선정 결과·판정 결과.",
        "meetingContent: 사례회의록 내용·논의 사항.",
        "meetingDecision: 회의 결정사항·합의 내용.",
        "반드시 아래 JSON 형식만 응답하세요:",
        '{"assessedAt":"YYYY-MM-DD","livingCondition":"","healthCondition":"","mealCondition":"","specialNotes":"","workerOpinion":"","selectionContent":"","selectionResult":"","meetingContent":"","meetingDecision":""}',
      ].join("\n");
      const content = await geminiChat(
        context.supabase,
        system,
        `문서 내용:\n\n${data.text.slice(0, 15000)}`,
        { json: true },
      );
      const p = parseJson<Record<string, unknown>>(content, {});
      const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      return {
        ok: true,
        assessedAt: normYmd(p.assessedAt) || "",
        livingCondition: s(p.livingCondition),
        healthCondition: s(p.healthCondition),
        mealCondition: s(p.mealCondition),
        specialNotes: s(p.specialNotes),
        workerOpinion: s(p.workerOpinion),
        selectionContent: s(p.selectionContent),
        selectionResult: s(p.selectionResult),
        meetingContent: s(p.meetingContent),
        meetingDecision: s(p.meetingDecision),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

/** 기관 전체 현황 분석 리포트. */
/** AI 출력에서 마크다운 기호 제거 (화면에 plain-text로 표시하므로) */
function stripMarkdown(text: string): string {
  return (text ?? "")
    // 제목 기호 (#, ##, ### 등) - 공백 유무 무관
    .replace(/^#{1,6}\s*/gm, "")
    // 굵게 (**text** 또는 __text__) — 다중 패스로 중첩 처리
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    // 기울임 (*text* 또는 _text_) — ** 제거 후 처리
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    // 수평선 (--- 또는 ***)
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // 인라인 코드
    .replace(/`([^`]+)`/g, "$1")
    // 코드 블록 펜스
    .replace(/^```[^\n]*$/gm, "")
    // 마크다운 불릿 (-, *, +) → 이미 ■/· 섞여 있으므로 제거만
    .replace(/^[ \t]*[-*+]\s+/gm, "· ")
    // 빈 줄 3개 이상 → 2개로
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 조직의 현황 요약 리포트 공유 캐시 조회 (다른 사용자가 분석한 결과 포함) */
export const getCachedReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const d = data as { orgId: string; reportKey?: string };
    if (!d?.orgId) throw new Error("orgId required");
    return { orgId: d.orgId, reportKey: d.reportKey ?? "overview_report" };
  })
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("ai_reports")
      .select("content,via,worker_name,analyzed_at")
      .eq("org_id", data.orgId)
      .eq("report_key", data.reportKey)
      .maybeSingle();
    if (error || !row) return { cached: null };
    return {
      cached: {
        report: row.content,
        via: (row.via ?? "AI") as "AI" | "로컬",
        workerName: row.worker_name ?? null,
        analyzedAt: row.analyzed_at,
      },
    };
  });

export const generateReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const d = (data ?? {}) as { program?: string };
    const valid = ["전체", "사례관리", "밑반찬", "무료급식"];
    return { program: valid.includes(d.program ?? "") ? (d.program as string) : "전체" };
  })
  .handler(async ({ data, context }) => {
    const program = data.program;
    const reportKey = program === "전체" ? "overview_report" : `overview_report_${program}`;

    // 로그인 사용자·기관 조회
    const { data: profile } = await context.supabase
      .from("profiles")
      .select("name,org_id")
      .eq("id", context.userId)
      .maybeSingle();
    const workerName = profile?.name ?? null;
    const orgId = profile?.org_id ?? null;

    // 서버에서 programsOf 로직 동일하게 구현
    const PS = new Set(["사례관리", "밑반찬", "무료급식"]);
    function serverProgramsOf(type: string | null): string[] {
      const raw = (type ?? "").split(/[,·/]/).map((s: string) => s.trim()).filter(Boolean);
      const known = raw.filter((p: string) => PS.has(p));
      return known.length ? [...new Set(known)] : ["사례관리"];
    }

    // 전체 대상자 조회 (note 포함)
    const { data: allRows } = await context.supabase
      .from("clients")
      .select("id,name,client_code,type,risk,progress,last_contact_at,needs,summary,grade,worker_name,note")
      .eq("org_id", orgId ?? "")
      .neq("grade", "종결")
      .limit(200);

    // 사업 필터
    const programRows = (allRows ?? []).filter((c) =>
      program === "전체" || serverProgramsOf(c.type).includes(program),
    );
    // AI 활용을 거부한 대상자는 분석에서 제외
    const { allowed: clients, excluded: aiExcluded } = await filterAiAllowed(context.supabase, programRows);
    const clientIdList = clients.map((c) => c.id).filter(Boolean);

    const careLevel = (g: string | null) =>
      (g ?? "").match(/중점|집중|위기|전문/) ? "중점" : "일반";

    // ── 최근 상담기록 (사례관리·무료급식·전체) ────────────────────────
    const recentLogsMap = new Map<string, { date: string; note: string; method: string }[]>();
    if (clientIdList.length > 0 && program !== "밑반찬") {
      const { data: logRows } = await context.supabase
        .from("activity_logs")
        .select("client_id,created_at,note,method")
        .in("client_id", clientIdList)
        .order("created_at", { ascending: false })
        .limit(300);
      (logRows ?? []).forEach((l) => {
        const arr = recentLogsMap.get(l.client_id) ?? [];
        if (arr.length < 3) {
          arr.push({ date: (l.created_at ?? "").slice(0, 10), note: (l.note ?? "").slice(0, 150), method: l.method ?? "" });
          recentLogsMap.set(l.client_id, arr);
        }
      });
    }

    // ── 최근 제공이력 (사례관리·밑반찬·전체) ─────────────────────────
    const recentProvsMap = new Map<string, { date: string; title: string; category: string }[]>();
    if (clientIdList.length > 0 && program !== "무료급식") {
      const { data: provRows } = await context.supabase
        .from("provisions")
        .select("client_id,provided_at,category,title")
        .in("client_id", clientIdList)
        .order("provided_at", { ascending: false })
        .limit(200);
      (provRows ?? []).forEach((p) => {
        const arr = recentProvsMap.get(p.client_id) ?? [];
        if (arr.length < 3) {
          arr.push({ date: p.provided_at ?? "", title: (p.title ?? "").slice(0, 80), category: p.category ?? "" });
          recentProvsMap.set(p.client_id, arr);
        }
      });
    }

    // ── 프로그램별 payload + 프롬프트 ────────────────────────────────
    let systemPrompt: string;
    let userPrompt: string;

    // 전 사업 공통 고품질 프롬프트 베이스 (전체 탭과 동일 수준)
    const BASE_SUPER = [
      "당신은 사회복지관 사례관리 분야에서 20년 이상 근무한 수석 슈퍼바이저입니다. 풍부한 현장 경험과 전문 지식을 바탕으로 실무자들에게 깊이 있는 슈퍼비전을 제공합니다.",
      "",
      "반드시 아래 '본깨적' 세 가지 항목으로만 답변하세요. 마크다운 기호(###, ##, **, *, ---, _)를 절대 사용하지 마세요. 섹션 제목은 ■ 기호로 시작하고, 하위 항목은 번호(1. 2. 3.)나 · 를 사용하세요.",
      "",
      "■ 본 것 (데이터에서 관찰된 구체적 사실 — 대상자(name 값)·상담 내용·수치 포함)",
      "■ 깨달은 것 (관찰에서 도출된 전문적 통찰·해석)",
      "■ 적용할 점 (실무자가 이번 주 즉시 실행할 수 있는 구체적 행동 지침)",
      "",
      "존댓말 사용. 각 항목은 3~5개 포인트로 간결하게 작성하세요.",
      AI_CODE_RULE,
    ].join("\n");

    if (program === "사례관리") {
      const payload = clients.map((c) => {
        const { reassessments } = splitNote(c.note);
        const latestR = reassessments[reassessments.length - 1] ?? null;
        return {
          name: aiLabel(c), 구분: careLevel(c.grade), 담당자: c.worker_name,
          risk: c.risk, progress: c.progress, lastContact: c.last_contact_at,
          needs: c.needs, summary: (c.summary ?? "").slice(0, 200),
          최근상담기록: recentLogsMap.get(c.id) ?? [],
          최근제공이력: recentProvsMap.get(c.id) ?? [],
          재사정: latestR ? {
            년도: latestR.carePlan?.year,
            욕구: ((latestR as Record<string, unknown>).needs as string ?? "").slice(0, 200),
          } : null,
        };
      });
      systemPrompt = BASE_SUPER + "\n\n사례관리 슈퍼비전입니다. 최근상담기록·최근제공이력·재사정 데이터에 실제 내용이 있으면 반드시 대상자(name 값)와 구체적 상황(수치, 질환명, 경제 상황, 가족 관계)을 언급하세요. 담당자별 상담 패턴·방법·빈도도 분석하세요.";
      userPrompt = `사례관리 대상자 데이터 (최근상담기록·최근제공이력·재사정 포함):\n${JSON.stringify(payload)}\n\n위 데이터를 분석하여 본깨적 형식으로 사례관리 슈퍼비전을 제공해 주세요.`;

    } else if (program === "밑반찬") {
      const payload = clients.map((c) => {
        const { sideDishAssessments } = splitNote(c.note);
        const latest = sideDishAssessments[sideDishAssessments.length - 1] ?? null;
        return {
          name: aiLabel(c), 구분: careLevel(c.grade), 담당자: c.worker_name,
          최근제공이력: recentProvsMap.get(c.id) ?? [],
          실태조사: latest ? {
            조사일: latest.assessedAt,
            생활실태: (latest.livingCondition ?? "").slice(0, 150),
            건강실태: (latest.healthCondition ?? "").slice(0, 150),
            급식실태: (latest.mealCondition ?? "").slice(0, 150),
            특이사항: (latest.specialNotes ?? "").slice(0, 150),
            사회복지사의견: (latest.workerOpinion ?? "").slice(0, 150),
          } : null,
        };
      });
      systemPrompt = BASE_SUPER + "\n\n밑반찬 사업 슈퍼비전입니다. 실태조사(생활실태·건강실태·급식실태·특이사항)와 제공이력에 실제 내용이 있으면 반드시 대상자(name 값)와 구체적 상황을 언급하세요. 영양 취약성, 반복 제공 패턴, 서비스 연속성, 추가 복지 욕구를 분석하세요.";
      userPrompt = `밑반찬 대상자 데이터 (실태조사+제공이력 포함):\n${JSON.stringify(payload)}\n\n위 데이터를 분석하여 본깨적 형식으로 밑반찬 사업 슈퍼비전을 제공해 주세요.`;

    } else if (program === "무료급식") {
      const payload = clients.map((c) => ({
        name: aiLabel(c), 구분: careLevel(c.grade), 담당자: c.worker_name,
        risk: c.risk, needs: c.needs, summary: (c.summary ?? "").slice(0, 200),
        최근상담기록: recentLogsMap.get(c.id) ?? [],
      }));
      systemPrompt = BASE_SUPER + "\n\n무료급식 사업 슈퍼비전입니다. 최근상담기록과 요약 정보에 실제 내용이 있으면 반드시 대상자(name 값)와 구체적 상황을 언급하세요. 급식 이용 취약군, 고위험 대상자의 복합 욕구, 급식 외 추가 지원 필요성을 분석하세요.";
      userPrompt = `무료급식 대상자 데이터 (최근상담기록 포함):\n${JSON.stringify(payload)}\n\n위 데이터를 분석하여 본깨적 형식으로 무료급식 사업 슈퍼비전을 제공해 주세요.`;

    } else {
      // 전체 — 기존 로직 유지
      const payload = clients.map((c) => ({
        name: aiLabel(c), type: c.type, 구분: careLevel(c.grade), 담당자: c.worker_name,
        risk: c.risk, progress: c.progress, lastContact: c.last_contact_at,
        needs: c.needs, summary: (c.summary ?? "").slice(0, 200),
        recentLogs: recentLogsMap.get(c.id) ?? [],
      }));
      systemPrompt = BASE_SUPER + "\n\nrecentLogs에 실제 상담기록이 있으면 반드시 내용을 참고하여 구체적 사례를 언급하세요.";
      userPrompt = `현재 관리 대상자 데이터 (recentLogs = 최근 상담기록 최대 3건):\n${JSON.stringify(payload)}\n\n위 데이터를 분석하여 본깨적 형식으로 슈퍼비전을 제공해 주세요.`;
    }

    const rawReport = await geminiChat(context.supabase, systemPrompt, userPrompt);
    const report =
      stripMarkdown(restoreNames(rawReport ?? "", clients)) +
      (aiExcluded > 0 ? `\n\n※ AI 활용을 거부한 대상자 ${aiExcluded}명은 분석에서 제외되었습니다.` : "");
    const analyzedAt = new Date().toISOString();

    // Supabase에 저장 — 조직 내 공유
    let saveError: string | null = null;
    if (orgId) {
      const { error: upsertErr } = await context.supabase
        .from("ai_reports")
        .upsert(
          { org_id: orgId, report_key: reportKey, content: report, via: "AI", worker_name: workerName, analyzed_at: analyzedAt },
          { onConflict: "org_id,report_key" },
        );
      if (upsertErr) saveError = upsertErr.message;

      // Google Drive 백업 (best-effort) — drive-proxy 경유
      try {
        await uploadTextToDrive(context.supabase, {
          name: `AI슈퍼비전_${program}_${analyzedAt.slice(0, 10)}.txt`,
          text: report,
          folderName: "AI리포트",
        });
      } catch (e) {
        console.warn("[AI리포트] Drive 백업 실패 (무시됨):", e);
      }
    }

    return { report, workerName, analyzedAt, saveError };
  });

export type NeedsAnalysis = {
  ok: boolean;
  message?: string;
  needs: string[];
  report: string;
  priorities: string[];
};

/** 대상자의 상담·제공·욕구를 종합한 '정성적' 욕구 분석. */
export const analyzeNeeds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const d = data as { clientId: string };
    if (!d?.clientId) throw new Error("clientId required");
    return d;
  })
  .handler(async ({ data, context }): Promise<NeedsAnalysis> => {
    await assertAiAllowed(context.supabase, data.clientId);
    const { data: c } = await context.supabase
      .from("clients")
      .select("type,needs,summary,note,grade,risk,progress")
      .eq("id", data.clientId)
      .maybeSingle();
    const { data: logs } = await context.supabase
      .from("activity_logs")
      .select("note,method,created_at")
      .eq("client_id", data.clientId)
      .order("created_at", { ascending: false })
      .limit(20);
    const { data: provs } = await context.supabase
      .from("provisions")
      .select("category,title,provided_at")
      .eq("client_id", data.clientId)
      .order("provided_at", { ascending: false })
      .limit(30);

    const needs = (c?.needs ?? []) as string[];
    const logText = (logs ?? []).map((l) => l.note ?? "").join("\n");
    const contextLen = (c?.summary ?? "").length + (c?.note ?? "").length + logText.length;
    if (needs.length === 0 && (provs ?? []).length === 0 && contextLen < 20) {
      return {
        ok: false,
        message: "분석할 상담·제공 정보가 부족합니다. 상담기록이나 욕구를 먼저 입력해 주세요.",
        needs: [],
        report: "",
        priorities: [],
      };
    }

    const ctx = [
      `대상자 유형: ${c?.type ?? "-"}`,
      `사례관리 구분/등급: ${c?.grade ?? "-"}`,
      `위험도: ${c?.risk ?? "-"}`,
      `목표 달성률: ${c?.progress ?? 0}%`,
      `등록된 욕구: ${needs.length ? needs.join(", ") : "(없음)"}`,
      `상담 요약: ${c?.summary ?? "(없음)"}`,
      `비고: ${c?.note ?? "(없음)"}`,
      "",
      "최근 상담기록:",
      ...(logs ?? []).map((l) => `- [${l.method ?? "-"}] ${(l.note ?? "").slice(0, 250)}`),
      "",
      "후원·제공 이력:",
      ...(provs ?? []).map((p) => `- ${p.category} · ${p.title} (${p.provided_at})`),
    ].join("\n");

    const system = [
      "당신은 한국 사회복지관의 사례관리 슈퍼바이저입니다.",
      "제공된 상담기록·제공이력·등록욕구만 근거로 대상자의 '정성적 욕구'를 분석합니다.",
      "근거가 없는 내용은 추측하지 말고, 불확실하면 그렇게 표현하세요. 존댓말을 사용합니다.",
      "반드시 아래 JSON 형식만 응답하세요:",
      '{"needs": ["핵심 욕구 키워드 3-6개"], "report": "정성 분석 서술 3-6문장(주요 호소·생활환경·정서·강점/보호요인 포함)", "priorities": ["우선 지원 제안 2-4개"]}',
    ].join("\n");

    const content = await geminiChat(context.supabase, system, ctx, { json: true });
    const parsed = parseJson<{ needs?: string[]; report?: string; priorities?: string[] }>(
      content,
      {},
    );
    return {
      ok: true,
      needs: clean(parsed.needs),
      report: (parsed.report ?? "").trim(),
      priorities: clean(parsed.priorities),
    };
  });

// ── 기관 상담기록이 존재하는 연도 목록 조회 ──────────────────────────────
/** activity_logs에 기록이 있는 연도 목록 반환 (드롭다운용). */
export const getLogYears = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const d = data as { orgId: string };
    if (!d?.orgId) throw new Error("orgId required");
    return d;
  })
  .handler(async ({ data, context }): Promise<{ years: number[] }> => {
    // created_at 연도만 추출 — Supabase는 date_part 미지원이므로 최소 데이터로 페이지 조회
    const { data: rows } = await context.supabase
      .from("activity_logs")
      .select("created_at")
      .eq("org_id", data.orgId)
      .order("created_at", { ascending: true })
      .limit(5000);
    const yearSet = new Set<number>();
    (rows ?? []).forEach((r) => {
      const y = parseInt((r.created_at ?? "").slice(0, 4), 10);
      if (!isNaN(y) && y > 2000) yearSet.add(y);
    });
    return { years: [...yearSet].sort((a, b) => b - a) };
  });

// ── 기관 전체 연도별 욕구 분포 AI 분석 ─────────────────────────────────
export type NeedsDistItem = {
  name: string;
  count: number;
  pct: number;
};

/**
 * 해당 연도의 상담기록 전체를 Gemini로 분석해 주요 욕구 TOP 5 반환.
 * 프론트엔드에서 localStorage에 캐싱하므로 동일 연도는 재호출하지 않는다.
 */
export const analyzeNeedsDist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const d = data as { year: number; orgId: string; clientIds?: string[]; reportKey?: string; program?: string };
    if (!d?.year || !d?.orgId) throw new Error("year, orgId required");
    const validPrograms = ["사례관리", "무료급식"];
    return {
      year: d.year,
      orgId: d.orgId,
      clientIds: Array.isArray(d.clientIds) ? d.clientIds : null,
      reportKey: d.reportKey ?? null,
      program: validPrograms.includes(d.program ?? "") ? (d.program as string) : null,
    };
  })
  .handler(async ({ data, context }): Promise<{ ok: boolean; top5: NeedsDistItem[]; error?: string }> => {
    // program 기반 clientIds 서버사이드 해석
    let resolvedClientIds: string[] | null = data.clientIds;
    if (!resolvedClientIds && data.program) {
      const PS = new Set(["사례관리", "밑반찬", "무료급식"]);
      const { data: clientRows } = await context.supabase
        .from("clients")
        .select("id,type")
        .eq("org_id", data.orgId)
        .neq("grade", "종결");
      resolvedClientIds = (clientRows ?? [])
        .filter((r) => {
          const types = (r.type ?? "").split(/[,·/]/).map((s: string) => s.trim()).filter(Boolean);
          const known = types.filter((p: string) => PS.has(p));
          const progs = known.length ? [...new Set(known)] : ["사례관리"];
          if (!progs.includes(data.program!)) return false;
          // 무료급식 욕구분포 분석: 사례관리 중복 대상자 제외 (재사정으로 관리)
          if (data.program === "무료급식" && progs.includes("사례관리")) return false;
          return true;
        })
        .map((r) => r.id);
    }

    // AI 활용을 거부한 대상자는 분석에서 제외
    let blockedIds: Set<string>;
    try {
      blockedIds = await getAiBlockedIds(context.supabase, { orgId: data.orgId });
    } catch (e) {
      return { ok: false, top5: [], error: (e as Error).message };
    }

    // ── 무료급식: 상담기록 대신 재사정+종합의견(mealOpinion)을 텍스트로 추출 ──
    if (data.program === "무료급식") {
      if (resolvedClientIds !== null && resolvedClientIds.length === 0)
        return { ok: false, top5: [], error: "해당 사업 대상자가 없습니다." };

      let clientQuery = context.supabase
        .from("clients")
        .select("id,note")
        .eq("org_id", data.orgId)
        .neq("grade", "종결");
      if (resolvedClientIds && resolvedClientIds.length > 0)
        clientQuery = clientQuery.in("id", resolvedClientIds);

      const { data: allClientRows, error: clientErr } = await clientQuery;
      if (clientErr) return { ok: false, top5: [], error: clientErr.message };
      const clientRows = (allClientRows ?? []).filter((r) => !blockedIds.has(r.id));

      const texts: string[] = [];
      (clientRows ?? []).forEach((row) => {
        const parsed = splitNote(row.note ?? "");
        // 재사정 내용
        parsed.reassessments.forEach((r) => {
          if (r.workerOpinion?.trim()) texts.push(r.workerOpinion.trim().slice(0, 400));
          if (r.result?.trim()) texts.push(r.result.trim().slice(0, 200));
          if (r.carePlan?.rows) {
            r.carePlan.rows.forEach((planRow) => {
              if (planRow.need)    texts.push(planRow.need.trim());
              if (planRow.problem) texts.push(planRow.problem.trim().slice(0, 200));
            });
          }
        });
        // 무료급식 종합의견 (mealOpinion 배열)
        parsed.mealOpinion.forEach((mo) => {
          if (mo.livingCondition?.trim())  texts.push(mo.livingCondition.trim().slice(0, 200));
          if (mo.healthCondition?.trim())  texts.push(mo.healthCondition.trim().slice(0, 200));
          if (mo.mealCondition?.trim())    texts.push(mo.mealCondition.trim().slice(0, 200));
          if (mo.specialNotes?.trim())     texts.push(mo.specialNotes.trim().slice(0, 200));
          if (mo.workerOpinion?.trim())    texts.push(mo.workerOpinion.trim().slice(0, 300));
        });
      });

      const filtered = texts.filter((t) => t.length > 5).slice(0, 150);
      if (filtered.length === 0)
        return { ok: false, top5: [], error: "분석할 재사정·종합의견 데이터가 없습니다." };

      const system = [
        "당신은 한국 노인복지관 사례관리 슈퍼바이저입니다.",
        `아래는 무료급식 대상자 ${(clientRows ?? []).length}명의 재사정 기록과 종합의견(생활·건강·급식 실태, 특이사항, 담당자 의견)입니다.`,
        "이 내용에서 실제 욕구·필요사항 TOP 5를 추출하세요.",
        "규칙:",
        "1) 행정 템플릿 단어(당사자, 욕구, 드러난, 확인, 진행 등)는 욕구가 아닙니다.",
        "2) 구체적 필요사항(경제적 지원, 건강 관리, 식사 지원, 주거 환경 개선, 정서적 지지 등)만 추출하세요.",
        "3) 비슷한 의미끼리 합산하고, name은 2~6자 한글로 간결하게.",
        "4) count는 해당 욕구가 언급된 대상자 수 추정값입니다.",
        "반드시 아래 JSON만 응답:",
        '{"top5":[{"name":"경제적 지원","count":20},{"name":"건강 관리","count":15},{"name":"식사 지원","count":10},{"name":"정서 지지","count":7},{"name":"주거 개선","count":4}]}',
      ].join("\n");

      const noteText = filtered.map((t, i) => `[${i + 1}] ${t}`).join("\n\n");

      try {
        const raw = await geminiChat(
          context.supabase,
          system,
          `무료급식 대상자 재사정·종합의견 (총 ${filtered.length}건):\n\n${noteText}`,
          { json: true },
        );
        const parsedResult = parseJson<{ top5: { name: string; count: number }[] }>(raw, { top5: [] });
        const totalCount = (parsedResult.top5 ?? []).reduce((s, x) => s + (x.count || 0), 0);
        const top5: NeedsDistItem[] = (parsedResult.top5 ?? [])
          .slice(0, 5)
          .map((x) => ({
            name: (x.name ?? "").trim(),
            count: Math.max(0, Math.round(x.count || 0)),
            pct: Math.round(((x.count || 0) / Math.max(1, totalCount)) * 100),
          }))
          .filter((x) => x.name && x.count > 0);

        if (data.reportKey && top5.length > 0) {
          const { data: profile } = await context.supabase
            .from("profiles").select("org_id").eq("id", context.userId).maybeSingle();
          if (profile?.org_id) {
            await context.supabase.from("ai_reports").upsert(
              { org_id: profile.org_id, report_key: data.reportKey, content: JSON.stringify({ top5 }), via: "AI", analyzed_at: new Date().toISOString() },
              { onConflict: "org_id,report_key" },
            );
          }
        }
        return { ok: true, top5 };
      } catch (e) {
        return { ok: false, top5: [], error: (e as Error).message };
      }
    }

    // ── 일반 사업 (사례관리 등): 상담기록 기반 ──────────────────────────
    let query = context.supabase
      .from("activity_logs")
      .select("note")
      .eq("org_id", data.orgId)
      .gte("created_at", `${data.year}-01-01`)
      .lt("created_at", `${data.year + 1}-01-01`)
      .not("note", "is", null)
      .limit(200);

    // 사업 필터: clientIds가 있으면 해당 대상자 기록만 분석
    if (resolvedClientIds !== null && resolvedClientIds.length === 0) {
      return { ok: false, top5: [], error: "해당 사업 대상자가 없습니다." };
    }
    if (resolvedClientIds && resolvedClientIds.length > 0) {
      query = query.in("client_id", resolvedClientIds);
    }
    if (blockedIds.size > 0) {
      query = query.not("client_id", "in", `(${[...blockedIds].join(",")})`);
    }

    const { data: rows, error } = await query;
    if (error) return { ok: false, top5: [], error: error.message };

    const notes = (rows ?? [])
      .map((r) => (r.note ?? "").trim())
      .filter((n) => n.length > 10)
      .slice(0, 120);

    if (notes.length === 0)
      return { ok: false, top5: [], error: "분석할 상담기록이 없습니다." };

    const system = [
      "당신은 한국 노인복지관 사례관리 슈퍼바이저입니다.",
      `아래 ${notes.length}건의 상담기록에서 실제 욕구·필요사항 TOP 5를 추출하세요.`,
      "규칙:",
      "1) '당사자', '욕구', '드러난', '문제', '어려움', '지원', '연계', '확인', '진행' 등 행정 템플릿 단어는 욕구가 아닙니다.",
      "2) 구체적 필요사항(경제적 지원, 건강 관리, 식사 지원, 주거 환경 개선, 정서적 지지 등)만 추출하세요.",
      "3) 비슷한 의미끼리 합산하고, name은 2~6자 한글로 간결하게.",
      "4) count는 해당 욕구가 언급된 기록 수 추정값입니다.",
      "반드시 아래 JSON만 응답:",
      '{"top5":[{"name":"경제적 지원","count":24},{"name":"건강 관리","count":17},{"name":"식사 지원","count":12},{"name":"정서 지지","count":8},{"name":"주거 개선","count":5}]}',
    ].join("\n");

    const noteText = notes.map((n, i) => `[${i + 1}] ${n.slice(0, 300)}`).join("\n\n");

    try {
      const raw = await geminiChat(
        context.supabase,
        system,
        `${data.year}년 상담기록 (총 ${notes.length}건):\n\n${noteText}`,
        { json: true },
      );
      const parsed = parseJson<{ top5: { name: string; count: number }[] }>(raw, { top5: [] });
      const totalCount = (parsed.top5 ?? []).reduce((s, x) => s + (x.count || 0), 0);
      const top5: NeedsDistItem[] = (parsed.top5 ?? [])
        .slice(0, 5)
        .map((x) => ({
          name: (x.name ?? "").trim(),
          count: Math.max(0, Math.round(x.count || 0)),
          pct: Math.round(((x.count || 0) / Math.max(1, totalCount)) * 100),
        }))
        .filter((x) => x.name && x.count > 0);

      // Supabase에 저장해 조직 내 공유 (reportKey가 있을 때만)
      if (data.reportKey && top5.length > 0) {
        const { data: profile } = await context.supabase
          .from("profiles")
          .select("org_id")
          .eq("id", context.userId)
          .maybeSingle();
        if (profile?.org_id) {
          await context.supabase.from("ai_reports").upsert(
            {
              org_id: profile.org_id,
              report_key: data.reportKey,
              content: JSON.stringify({ top5 }),
              via: "AI",
              analyzed_at: new Date().toISOString(),
            },
            { onConflict: "org_id,report_key" },
          );
        }
      }

      return { ok: true, top5 };
    } catch (e) {
      return { ok: false, top5: [], error: (e as Error).message };
    }
  });

/** 밑반찬 실태조사 기반 욕구 분포 AI 분석 */
export const analyzeSideDishNeedsDist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const d = data as { orgId: string };
    if (!d?.orgId) throw new Error("orgId required");
    return d;
  })
  .handler(async ({ data, context }): Promise<{ ok: boolean; top5: NeedsDistItem[]; error?: string }> => {
    // 밑반찬 대상자 note 필드 조회
    const { data: allRows, error } = await context.supabase
      .from("clients")
      .select("id,note,type")
      .eq("org_id", data.orgId)
      .neq("grade", "종결")
      .limit(200);

    if (error) return { ok: false, top5: [], error: error.message };
    // AI 활용을 거부한 대상자는 분석에서 제외
    let blockedIds: Set<string>;
    try {
      blockedIds = await getAiBlockedIds(context.supabase, { orgId: data.orgId });
    } catch (e) {
      return { ok: false, top5: [], error: (e as Error).message };
    }
    const rows = (allRows ?? []).filter((r) => !blockedIds.has(r.id));

    // 밑반찬 대상자의 실태조사 텍스트 추출
    const PS = new Set(["사례관리", "밑반찬", "무료급식"]);
    const texts: string[] = [];
    (rows ?? []).forEach((row) => {
      const typeArr = (row.type ?? "").split(/[,·/]/).map((s: string) => s.trim()).filter(Boolean);
      const known = typeArr.filter((p: string) => PS.has(p));
      const progs = known.length ? [...new Set(known)] : ["사례관리"];
      if (!progs.includes("밑반찬")) return;

      try {
        const { sideDishAssessments } = splitNote(row.note);
        sideDishAssessments.forEach((a) => {
          const parts = [
            a.livingCondition, a.healthCondition, a.mealCondition,
            a.specialNotes, a.workerOpinion, a.selectionContent,
          ].filter(Boolean).join(" | ");
          if (parts.trim().length > 10) texts.push(parts.slice(0, 400));
        });
      } catch { /* 파싱 실패 무시 */ }
    });

    if (texts.length === 0)
      return { ok: false, top5: [], error: "분석할 실태조사 내용이 없습니다." };

    const system = [
      "당신은 한국 노인복지관 슈퍼바이저입니다.",
      `아래 ${texts.length}건의 밑반찬 실태조사에서 대상자의 실제 욕구·필요사항 TOP 5를 추출하세요.`,
      "규칙:",
      "1) 생활실태·건강실태·급식실태·특이사항·사회복지사 의견을 종합적으로 분석하세요.",
      "2) 구체적 필요사항(경제적 어려움, 건강 문제, 영양 불량, 사회적 고립, 주거 열악 등)만 추출하세요.",
      "3) 비슷한 의미끼리 합산하고, name은 2~8자 한글로 간결하게.",
      "4) count는 해당 욕구가 나타난 조사 건수 추정값입니다.",
      "반드시 아래 JSON만 응답:",
      '{"top5":[{"name":"영양 불량","count":12},{"name":"건강 악화","count":10},{"name":"경제적 어려움","count":8},{"name":"사회적 고립","count":5},{"name":"주거 불량","count":3}]}',
    ].join("\n");

    try {
      const raw = await geminiChat(
        context.supabase,
        system,
        `밑반찬 실태조사 (총 ${texts.length}건):\n\n${texts.map((t, i) => `[${i + 1}] ${t}`).join("\n\n")}`,
        { json: true },
      );
      const parsed = parseJson<{ top5: { name: string; count: number }[] }>(raw, { top5: [] });
      const totalCount = (parsed.top5 ?? []).reduce((s, x) => s + (x.count || 0), 0);
      const top5: NeedsDistItem[] = (parsed.top5 ?? [])
        .slice(0, 5)
        .map((x) => ({
          name: (x.name ?? "").trim(),
          count: Math.max(0, Math.round(x.count || 0)),
          pct: Math.round(((x.count || 0) / Math.max(1, totalCount)) * 100),
        }))
        .filter((x) => x.name && x.count > 0);

      // Supabase에 저장해 조직 내 공유
      if (top5.length > 0) {
        const { data: profile } = await context.supabase
          .from("profiles")
          .select("org_id")
          .eq("id", context.userId)
          .maybeSingle();
        if (profile?.org_id) {
          await context.supabase.from("ai_reports").upsert(
            {
              org_id: profile?.org_id ?? data.orgId,
              report_key: "sidedish_needs",
              content: JSON.stringify({ top5 }),
              via: "AI",
              analyzed_at: new Date().toISOString(),
            },
            { onConflict: "org_id,report_key" },
          );
        }
      }

      return { ok: true, top5 };
    } catch (e) {
      return { ok: false, top5: [], error: (e as Error).message };
    }
  });

/** Supabase에 저장된 욕구 분포 캐시 조회 (조직 내 공유용) */
export const getCachedNeedsDist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const d = data as { orgId: string; reportKey: string };
    if (!d?.orgId || !d?.reportKey) throw new Error("orgId, reportKey required");
    return d;
  })
  .handler(async ({ data, context }): Promise<{ cached: { top5: NeedsDistItem[]; analyzedAt: string } | null }> => {
    const { data: row } = await context.supabase
      .from("ai_reports")
      .select("content,analyzed_at")
      .eq("org_id", data.orgId)
      .eq("report_key", data.reportKey)
      .maybeSingle();
    if (!row?.content) return { cached: null };
    try {
      const parsed = JSON.parse(row.content) as { top5: NeedsDistItem[] };
      return { cached: { top5: parsed.top5 ?? [], analyzedAt: row.analyzed_at } };
    } catch {
      return { cached: null };
    }
  });



/** 무료급식 종합의견 PDF(이용자 관리카드·인테이크기록지)에서 내용 추출. (analyzeSideDishAssessment와 동일 구조) */
export interface MealOpinionPdfResult {
  ok: boolean;
  recordedAt?: string;
  livingCondition?: string;
  healthCondition?: string;
  mealCondition?: string;
  specialNotes?: string;
  workerOpinion?: string;
  selectionContent?: string;
  error?: string;
}

export const analyzeMealOpinion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const d = data as { text: string; clientId?: string };
    if (!d?.text || typeof d.text !== "string") throw new Error("text required");
    if (d.text.trim().length < 20)
      throw new Error("분석할 내용이 부족합니다. PDF에 텍스트가 포함되어 있는지 확인해 주세요.");
    return d;
  })
  .handler(async ({ data, context }): Promise<MealOpinionPdfResult> => {
    await assertAiAllowed(context.supabase, data.clientId);
    try {
      const system = [
        "당신은 한국 노인복지관의 사회복지사입니다.",
        "아래 PDF 문서는 무료급식(경로식당) 사업의 이용자 관리카드 또는 인테이크기록지입니다.",
        "이름·생년월일·주소 등 개인정보는 추출하지 마세요. 오직 조사 내용만 추출합니다.",
        "recordedAt(기록일): 문서에 기재된 '기록일', '작성일', '조사일', '신청일' 등에서 YYYY-MM-DD 형식으로 추출. 없으면 빈 문자열.",
        "각 항목은 문서에서 해당 내용을 그대로 발췌하되 자연스럽게 정리. 없으면 빈 문자열.",
        "livingCondition: 생활환경·거주실태·가족관계·일상생활 관련 내용.",
        "healthCondition: 건강상태·질환·의료·신체기능·거동 관련 내용.",
        "mealCondition: 식생활·영양상태·결식 여부·급식 이용 현황·신청 사유 관련 내용.",
        "specialNotes: 특이사항·특이 내용·메모·기타.",
        "workerOpinion: 사회복지사 종합의견·소견·판단·지원 방향.",
        "selectionContent: 선정 내용·선발 사유·자산·소득·부양의무자 등 선정 관련 내용.",
        "반드시 아래 JSON 형식만 응답하세요:",
        '{"recordedAt":"YYYY-MM-DD","livingCondition":"","healthCondition":"","mealCondition":"","specialNotes":"","workerOpinion":"","selectionContent":""}',
      ].join("\n");
      const content = await geminiChat(
        context.supabase,
        system,
        `문서 내용:\n\n${data.text.slice(0, 15000)}`,
        { json: true },
      );
      const p = parseJson<Record<string, unknown>>(content, {});
      const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      return {
        ok: true,
        recordedAt: normYmd(p.recordedAt) || "",
        livingCondition: s(p.livingCondition),
        healthCondition: s(p.healthCondition),
        mealCondition: s(p.mealCondition),
        specialNotes: s(p.specialNotes),
        workerOpinion: s(p.workerOpinion),
        selectionContent: s(p.selectionContent),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

// ── 종결보고서 AI 분석 ──────────────────────────────────────────────────────
export interface ClosureAiResult {
  closure_date: string;
  case_status: Record<string, string>;
  service_history: { date: string; content: string }[];
  closure_reason: string;
  worker_opinion: string;
  closure_type: string;
  closure_type_detail: string;
  closure_result: string;
  referral_org: string;
  written_by: string;
}

export const analyzeClosureReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const d = data as { text: string; clientId?: string };
    if (!d?.text || typeof d.text !== "string") throw new Error("text required");
    if (d.text.trim().length < 20) throw new Error("분석할 내용이 부족합니다.");
    return d;
  })
  .handler(async ({ data, context }): Promise<ClosureAiResult> => {
    await assertAiAllowed(context.supabase, data.clientId);
    const system = [
      "당신은 한국 노인복지관 사례관리 슈퍼바이저입니다.",
      "아래 서비스 종결 평가 보고서를 분석해 JSON만 응답하세요. 근거 없는 내용은 추측하지 마세요.",
      "날짜는 YYYY-MM-DD 형식. 없으면 빈 문자열.",
      "closure_type은 다음 중 하나: 서비스거부, 연락두절, 이사, 사망, 기타. 없으면 빈 문자열.",
      "closure_result는 종결 또는 타기관의뢰 중 하나. 없으면 종결.",
      "{",
      '"closure_date":"종결평가 일자 YYYY-MM-DD",',
      '"case_status":{"인테이크":"횟수","재사정":"횟수","사례회의":"횟수","서비스계획":"횟수","서비스점검":"횟수"},',
      '"service_history":[{"date":"날짜 문자열","content":"서비스 내용"}],',
      '"closure_reason":"종결 사유 전문",',
      '"worker_opinion":"담당자 의견 전문",',
      '"closure_type":"종결 유형",',
      '"closure_type_detail":"기타인 경우 상세",',
      '"closure_result":"종결 또는 타기관의뢰",',
      '"referral_org":"타기관 의뢰 시 기관명",',
      '"written_by":"작성자(담당 사회복지사)"',
      "}",
    ].join("\n");
    const content = await geminiChat(
      context.supabase,
      system,
      `종결보고서:\n\n${data.text.slice(0, 15000)}`,
      { json: true },
    );
    const p = parseJson<Record<string, unknown>>(content, {});
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const csRaw = (p.case_status ?? {}) as Record<string, unknown>;
    const cs: Record<string, string> = {};
    for (const k of ["인테이크", "재사정", "사례회의", "서비스계획", "서비스점검"]) {
      const v = csRaw[k];
      if (typeof v === "string" && v.trim()) cs[k] = v.trim();
      else if (typeof v === "number") cs[k] = String(v);
    }
    const shRaw = Array.isArray(p.service_history) ? (p.service_history as Record<string, unknown>[]) : [];
    const serviceHistory = shRaw
      .map((r) => ({ date: s(r.date), content: s(r.content) }))
      .filter((r) => r.date || r.content);
    return {
      closure_date: normYmd(p.closure_date),
      case_status: cs,
      service_history: serviceHistory.length ? serviceHistory : [{ date: "", content: "" }],
      closure_reason: s(p.closure_reason),
      worker_opinion: s(p.worker_opinion),
      closure_type: s(p.closure_type),
      closure_type_detail: s(p.closure_type_detail),
      closure_result: s(p.closure_result) || "종결",
      referral_org: s(p.referral_org),
      written_by: s(p.written_by),
    };
  });
