// 복순이(말벗 챗봇) 모니터링 — companion-proxy 엣지 함수를 통해 RPC를 호출한다.
// MONITOR_SECRET은 서버에만 존재하며 클라이언트 번들에 포함되지 않는다.
import type { SupabaseClient } from "@supabase/supabase-js";

export type RiskLevel = "경고" | "주의" | "점검" | "정상";

export type MonitorItem = {
  session_id: string;
  name: string | null;
  verified: boolean; // 사례관리 대상자와 연결(기관 인증)
  care_client_id: string | null;
  last_active_at: string | null;
  created_at: string | null;
  msg_count: number;
  user_msg_count: number;
  last_user_message: string | null;
  recent_user_text: string | null;
  // 아래는 클라이언트에서 계산
  risk: RiskLevel;
  keywords: string[];
};

export type MonitorMessage = { id?: string; role: string; content: string; created_at: string };

// 위험 키워드(높은 순). 어르신 발화에서 탐지.
const RISK_RULES: { level: Exclude<RiskLevel, "정상">; re: RegExp }[] = [
  // ── 자살·자해 위기 발언 ──────────────────────────────
  {
    level: "경고",
    re: /자살|죽고\s*싶|죽고싶|목숨|자해|극단적|살기\s*싫|사라지고\s*싶|없어지고\s*싶|다\s*끝내/g,
  },
  // ── 긴급 건강 상황 (낙상·흉통·호흡 곤란 등) ──────────
  {
    level: "경고",
    re: /넘어졌|쓰러졌|쓰러|119|구급차|응급실|가슴\s*아프|숨\s*못\s*쉬|숨이\s*안|기절|의식\s*없|다쳤|골절/g,
  },
  // ── 보이스피싱·금융 사기 의심 ───────────────────────
  {
    level: "경고",
    re: /보이스피싱|검찰이라고|경찰이라고|계좌번호|돈\s*보내|송금|사기\s*전화|통장\s*빌려/g,
  },
  // ── 심리 위기 ────────────────────────────────────────
  { level: "주의", re: /우울|슬퍼|슬프|외로|눈물|괴로|힘들|포기|무기력|희망\s*없|살기\s*힘|서글/g },
  // ── 일상 불편 ────────────────────────────────────────
  { level: "점검", re: /아파|아프|잠\s*못|잠\s*안|불면|불안|혼자|쓸쓸|답답|서럽|막막|짜증|화가/g },
];
const RANK: Record<RiskLevel, number> = { 경고: 3, 주의: 2, 점검: 1, 정상: 0 };
export const riskRank = (r: RiskLevel) => RANK[r];

export const riskTone: Record<RiskLevel, string> = {
  경고: "border-red-400 text-red-700 bg-red-50",
  주의: "border-amber-400 text-amber-700 bg-amber-50",
  점검: "border-sky-400 text-sky-700 bg-sky-50",
  정상: "border-border text-muted-foreground bg-transparent",
};

/** 텍스트에서 위험도와 매칭 키워드를 계산한다. */
export function classifyRisk(text: string | null | undefined): { risk: RiskLevel; keywords: string[] } {
  const t = text ?? "";
  let risk: RiskLevel = "정상";
  const kws = new Set<string>();
  for (const rule of RISK_RULES) {
    const matches = t.match(rule.re);
    if (matches && matches.length) {
      matches.forEach((m) => kws.add(m.replace(/\s+/g, " ").trim()));
      if (RANK[rule.level] > RANK[risk]) risk = rule.level;
    }
  }
  return { risk, keywords: [...kws].slice(0, 8) };
}

/** companion-proxy 엣지 함수를 통해 RPC 호출. */
async function callProxy<T>(supabase: SupabaseClient, action: string, extra?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("companion-proxy", {
    body: { action, ...extra },
  });
  if (error) {
    const msg = error.message ?? String(error);
    throw new Error(msg.includes("404") ? "RPC_NOT_FOUND" : msg);
  }
  return data as T;
}

type ListResp = { ok: boolean; reason?: string; orgCode?: string; items?: Omit<MonitorItem, "risk" | "keywords">[] };
type DetailResp = { ok: boolean; reason?: string; name?: string; messages?: MonitorMessage[] };

/** 기관코드로 복순이 이용 어르신 목록 + 위험 분류를 가져온다. */
export async function fetchMonitorList(supabase: SupabaseClient, orgCode: string): Promise<{
  items: MonitorItem[];
  summary: { total: number; 경고: number; 주의: number; 점검: number };
}> {
  const r = await callProxy<ListResp>(supabase, "list", { orgCode });
  if (!r.ok) throw new Error(r.reason || "unknown");
  const items: MonitorItem[] = (r.items ?? []).map((it) => {
    const { risk, keywords } = classifyRisk(it.recent_user_text);
    return { ...it, risk, keywords };
  });
  items.sort(
    (a, b) =>
      RANK[b.risk] - RANK[a.risk] ||
      (b.last_active_at ?? "").localeCompare(a.last_active_at ?? ""),
  );
  const summary = {
    total: items.length,
    경고: items.filter((i) => i.risk === "경고").length,
    주의: items.filter((i) => i.risk === "주의").length,
    점검: items.filter((i) => i.risk === "점검").length,
  };
  return { items, summary };
}

/** 어르신 대화 세션을 복순이 DB에서 완전 삭제한다 (chat_messages + seniors). */
export async function deleteCompanionSession(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<void> {
  const r = await callProxy<{ ok: boolean; error?: string }>(supabase, "delete", { sessionId });
  if (!r.ok) throw new Error(r.error || "삭제 실패");
}

/** 한 어르신의 전체 대화를 가져온다. */
export async function fetchMonitorDetail(
  supabase: SupabaseClient,
  orgCode: string,
  sessionId: string,
): Promise<{ name: string; messages: MonitorMessage[] }> {
  const r = await callProxy<DetailResp>(supabase, "detail", { orgCode, sessionId });
  if (!r.ok) throw new Error(r.reason || "unknown");
  return { name: r.name ?? "", messages: r.messages ?? [] };
}

/** 어르신 발화 텍스트에서 위험 키워드를 찾아 파트 배열로 반환한다. */
export function highlightRiskKeywords(
  text: string,
): Array<{ part: string; level: Exclude<RiskLevel, "정상"> | null }> {
  if (!text.trim()) return [{ part: text, level: null }];

  type Match = { start: number; end: number; level: Exclude<RiskLevel, "정상"> };
  const allMatches: Match[] = [];

  for (const rule of RISK_RULES) {
    const re = new RegExp(rule.re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      allMatches.push({ start: m.index, end: m.index + m[0].length, level: rule.level });
    }
  }

  if (allMatches.length === 0) return [{ part: text, level: null }];

  // 시작 위치 순, 같은 위치면 더 심각한 레벨 우선
  allMatches.sort((a, b) => a.start - b.start || RANK[b.level] - RANK[a.level]);

  const result: Array<{ part: string; level: Exclude<RiskLevel, "정상"> | null }> = [];
  let pos = 0;
  for (const match of allMatches) {
    if (match.start < pos) continue; // 겹침 스킵
    if (match.start > pos) result.push({ part: text.slice(pos, match.start), level: null });
    result.push({ part: text.slice(match.start, match.end), level: match.level });
    pos = match.end;
  }
  if (pos < text.length) result.push({ part: text.slice(pos), level: null });
  return result;
}

/** 개별 메시지 삭제 (복순이 DB에서 완전 삭제). */
export async function deleteCompanionMessage(
  supabase: SupabaseClient,
  messageId: string,
  sessionId: string,
  orgCode: string,
): Promise<void> {
  const r = await callProxy<{ ok: boolean; error?: string }>(supabase, "deleteMessage", { messageId, sessionId, orgCode });
  if (!r.ok) throw new Error(r.error || "삭제 실패");
}
