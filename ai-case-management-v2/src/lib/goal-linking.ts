// 재사정 욕구 → 서비스 목표 변환 + 정량(수치) 목표량·달성 점검 공용 로직.
// [재사정] 탭의 "서비스 목표 반영" 과 [서비스 목표] 탭의 "재사정으로 목표 수립" 이 동일 결과를 내도록 공유한다.
import type { ReassessNeed, Goal, ActivityLog, Provision } from "./case-types";

export type TargetPeriod = "주" | "월" | "분기" | "년";
export const TARGET_PERIODS: TargetPeriod[] = ["주", "월", "분기", "년"];

// 담당자 입력 기본값: 월 2회
export const DEFAULT_TARGET: { period: TargetPeriod; count: number } = { period: "월", count: 2 };

// 주기별 월 환산 계수 (월 기대 횟수 = count * 계수)
const PER_MONTH: Record<TargetPeriod, number> = { 주: 4.345, 월: 1, 분기: 1 / 3, 년: 1 / 12 };

/** detail 첫 줄의 "목표량: 주기 N회" 를 파싱한다. */
export function parseTarget(
  detail?: string | null,
): { period: TargetPeriod; count: number } | null {
  if (!detail) return null;
  const m = detail.match(/목표량:\s*(주|월|분기|년)\s*(\d+)\s*회/);
  if (!m) return null;
  return { period: m[1] as TargetPeriod, count: Number(m[2]) };
}

/** 재사정 욕구의 점검주기(checkCycle)에서 기본 목표량을 추론. 없으면 월 2회. */
export function defaultTargetFor(n: ReassessNeed): { period: TargetPeriod; count: number } {
  return parseTarget(n.checkCycle) ?? { ...DEFAULT_TARGET };
}

/** 사람이 읽는 목표량 라벨. */
export function targetLabel(period: TargetPeriod, count: number): string {
  return `${period} ${count}회`;
}

/** detail 맨 위에 "📊 목표량: 주기 N회" 줄을 붙인다(기존 목표량 줄은 교체). */
export function withTargetLine(period: TargetPeriod, count: number, body: string): string {
  const clean = (body ?? "").replace(/^📊?\s*목표량:.*\n?/, "").trim();
  const line = `📊 목표량: ${targetLabel(period, count)}`;
  return clean ? `${line}\n${clean}` : line;
}

/** 목표 제목·세부에서 2글자 이상 키워드 추출. */
function tokensOf(title: string, detail?: string | null): string[] {
  return `${title} ${detail ?? ""}`
    .split(/[\s,·/()\n]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^목표량:?$/.test(t));
}

/** 목표와 관련된 상담기록·제공이력 건수(정량 근거). */
export function matchedActivity(
  title: string,
  detail: string | null,
  logs: ActivityLog[],
  provisions: Provision[],
): number {
  const toks = tokensOf(title, detail);
  if (toks.length === 0) return 0;
  const l = logs.filter((x) => toks.some((t) => (x.note ?? "").includes(t))).length;
  const p = provisions.filter((x) => toks.some((t) => (x.title ?? "").includes(t))).length;
  return l + p;
}

/** 목표량(주기·횟수) 대비 실제 활동으로 달성률(%)을 계산. 목표량 없으면 null. */
export function targetAchievement(
  goal: { title: string; detail: string | null; created_at?: string },
  logs: ActivityLog[],
  provisions: Provision[],
): number | null {
  const t = parseTarget(goal.detail);
  if (!t) return null;
  const start = goal.created_at ? new Date(goal.created_at).getTime() : Date.now();
  const months = Math.max(1, (Date.now() - start) / (30 * 86400000));
  const expected = Math.max(1, PER_MONTH[t.period] * t.count * months);
  const actual = matchedActivity(goal.title, goal.detail, logs, provisions);
  return Math.min(100, Math.round((actual / expected) * 100));
}

/** 재사정 욕구 → 목표 본문(제목 + 세부 서술). 점검주기는 목표량으로 분리되므로 제외. */
export function needToGoalBody(n: ReassessNeed): { title: string; body: string } {
  return {
    title: n.goal || n.need || "서비스 목표",
    body: [
      n.problem && `요구/문제: ${n.problem}`,
      n.need && `욕구: ${n.need}`,
      n.clientAction && `당사자 행동계획: ${n.clientAction}`,
      n.workerAction && `담당자 행동계획: ${n.workerAction}`,
      n.priority && `우선순위: ${n.priority}`,
      n.urgency && `긴급성: ${n.urgency}`,
      n.criteria && `목표달성 기준: ${n.criteria}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** 기존 목표에서 이 욕구와 유사한 항목 찾기(욕구 키워드 부분일치). */
export function matchGoal(need: ReassessNeed, existing: Goal[]): Goal | null {
  const key = (need.need || need.goal || "").trim();
  if (!key) return null;
  return (
    existing.find(
      (g) => g.title.includes(key) || (g.detail ?? "").includes(key) || key.includes(g.title),
    ) ?? null
  );
}
