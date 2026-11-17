import { ClientName } from "@/components/NameMask";
import { toKstDate } from "@/lib/log-time";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
} from "recharts";
import {
  AlertTriangle,
  Users,
  CalendarIcon,
  BarChart3,
  ClipboardList,
  UserCheck,
  TrendingUp,
  Info,
  Package,
  MessageSquare,
  FileText,
  Target,
} from "lucide-react";
import {
  daysSince,
  riskStyle,
  RISK_LEVELS,
  programsOf,
  matchesScope,
  isTerminated,
  workerRoster,
  splitNote,
  type Client,
  type ActivityLog,
  type Provision,
  type OrgRow,
  type CarePlanAction,
} from "@/lib/case-types";
import { overrideActionLinks, type CarePlanLinkRow } from "@/lib/care-plan-links";
import { ScopeFilter } from "./ScopeFilter";
import { ActivityTrendChart } from "./ActivityTrendChart";
import { useServerFn } from "@tanstack/react-start";
import { AiModelBadge } from "@/components/AiModelBadge";
import { toast } from "sonner";
import { logView } from "@/lib/view-log";
import { generateReport, getCachedReport, analyzeNeedsDist, analyzeSideDishNeedsDist, getCachedNeedsDist, getLogYears, type NeedsDistItem } from "@/lib/ai.functions";

type Props = {
  clients: Client[];
  logs: ActivityLog[];
  provisions: Provision[];
  org: OrgRow | null;
  planLinks?: CarePlanLinkRow[];
};

// ── 계획 달성률 계산 (ServiceGoalsTab.computeActionResult와 동일 — linkedIds 기반) ──
// 키워드 자동 매칭 제거: 담당자가 직접 연동한 항목(linkedLogIds/linkedProvIds)만 사용
function actionRate(action: CarePlanAction, linkedLogIds: Set<string>, linkedProvIds: Set<string>): number {
  if (action.manualRate != null) return action.manualRate;
  const linkedIds = new Set([
    ...(action.linkedLogIds ?? []).filter((id) => linkedLogIds.has(id)),
    ...(action.linkedProvIds ?? []).filter((id) => linkedProvIds.has(id)),
  ]);
  const achievedCount = linkedIds.size;
  return action.targetCount
    ? Math.min(100, Math.round((achievedCount / action.targetCount) * 100))
    : Math.min(100, achievedCount * 25);
}

// 클라이언트 1명의 전체 계획 달성률 (ServiceGoalsTab planRate와 동일한 2단계 평균)
function clientPlanRate(
  client: Client,
  allLogs: ActivityLog[],
  allProvisions: Provision[],
  year: number,
  allPlanLinks: CarePlanLinkRow[] = [],
): number | null {
  const { reassessments } = splitNote(client.note);
  const plan = reassessments.find((r) => r.carePlan?.year === year)?.carePlan;
  if (!plan || !plan.rows.length) return null;
  // 해당 연도의 로그/제공이력 ID Set
  const yearLogIds = new Set(
    allLogs
      .filter((l) => l.client_id === client.id && toKstDate(l.created_at).startsWith(String(year)))
      .map((l) => l.id),
  );
  const yearProvIds = new Set(
    allProvisions
      .filter((p) => p.client_id === client.id && p.provided_at.startsWith(String(year)))
      .map((p) => p.id),
  );
  // care_plan_action_links 테이블 데이터로 action의 linked* 필드 오버라이드
  const clientYearLinks = allPlanLinks.filter(
    (l) => l.client_id === client.id && l.plan_year === year,
  );
  // 1단계: 각 행의 평균 달성률
  const rowRates = plan.rows.map((row) => {
    const baseActions = [...row.selfPlan, ...row.workerPlan];
    const actions = overrideActionLinks(baseActions, clientYearLinks);
    if (actions.length === 0) return 0;
    const s = actions.reduce((acc, a) => acc + actionRate(a, yearLogIds, yearProvIds), 0);
    return Math.round(s / actions.length);
  });
  // 2단계: 행 평균들의 평균
  return Math.round(rowRates.reduce((acc, r) => acc + r, 0) / rowRates.length);
}

// ── 상담 기록 기반 욕구 키워드 매핑 ─────────────────────────────────
// ── 상담 note 명사 추출용 불용어 ─────────────────────────────────────
const NOTE_STOPWORDS = new Set([
  // 동작/상태 동사성 명사
  "지원","연계","실시","확인","진행","완료","예정","시작","종료","처리",
  "방문","전화","내방","상담","면담","접촉","연락","안내","설명","보고",
  "요청","신청","접수","서비스","제공","이용","사용","활용","적용",
  "파악","검토","협의","논의","조정","수립","이행","실천","추진","수행",
  // 일반 명사 (너무 광범위)
  "대상","대상자","본인","어르신","할머니","할아버지","노인","어머니","아버지",
  "담당","담당자","복지사","사회복지사","선생님","직원","관계자",
  "기관","센터","복지관","병원","의원","주민센터","사무소",
  "내용","사항","결과","상태","상황","현황","현재","최근","이번","다음",
  "금일","오늘","내일","어제","주간","월간","이후","이전",
  // 조사·접속사처럼 쓰이는 것
  "및","등","또한","함께","위해","통해","대한","관련","경우","부분",
  "하기","하여","하고","하면","하였","하였음","됩니다","합니다",
  "있음","없음","됨","임","함","함께","경우에","따라","있어",
  // 수량·단위
  "회","번","개","명","건","원","만원","천원","월","일","년","차",
  // ── 사례관리 계획서 템플릿 고정 단어 (가장 흔히 오탐되는 항목들) ──
  "당사자","욕구","드러난","문제","어려움","불편",
  "행동","계획","목표","실행","달성","우선","긴급","우선순위",
  "영역","분야","항목","유형","종류",
  // 사례관리 과정 용어
  "사례","관리","기록","작성","평가","의뢰","종결","재사정",
  "모니터링","점검","사정","개입","종합","전반",
  // 추가 인물·관계
  "가족","자녀","남편","아내","형제","부모","아들","딸","배우자","자녀분",
  // 추가 동작
  "통하여","의하여","위하여","따라서","그리고","또는","이후에","이전에",
  "가능","불가","해당","필요","중요","긴요","충분","불충분",
  "지속","유지","강화","개선","해결","해소","감소","증가","저하",
]);

// 상담 note에서 의미있는 구체적 명사만 추출
function extractNoteNouns(text: string): string[] {
  return text
    .replace(/\d+/g, "")                              // 숫자 제거
    .replace(/[a-zA-Z]+/g, "")                        // 영문 제거
    .split(/[\s,·\-\/()【】\[\]「」『』。、！？!?:：]+/) // 구분자로 분리
    .map((w) => w.trim().replace(/[을를이가은는도에서의]+$/, "")) // 조사 제거
    .filter((w) => {
      if (w.length < 2 || w.length > 7) return false; // 2~7자
      if (NOTE_STOPWORDS.has(w)) return false;         // 불용어 제거
      if (!/[가-힣]{2}/.test(w)) return false;         // 한글 2자 이상
      return true;
    });
}

// ── 색상 팔레트 ──────────────────────────────────────────────────────
const NEED_COLORS = [
  "#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981",
  "#3b82f6","#ef4444","#14b8a6","#f97316","#84cc16",
];
const RISK_COLORS: Record<string, string> = {
  "고위험": "#ef4444",
  "경고": "#f97316",
  "주의": "#f59e0b",
  "정상": "#10b981",
};

// ── 컴포넌트 ─────────────────────────────────────────────────────────
export function OverviewTab({ clients, logs, provisions, org, planLinks = [] }: Props) {
  const curYear = new Date().getFullYear();
  const [program, setProgram] = useState("전체");
  const [careFilter, setCareFilter] = useState<"전체" | "중점" | "일반">("전체");
  const [workerFilter, setWorkerFilter] = useState("전체");
  const [needsYear, setNeedsYear] = useState(curYear);
  const [planYear, setPlanYear] = useState(curYear);
  const [planClientId, setPlanClientId] = useState("");
  const [aiReport, setAiReport] = useState("");
  const [reportLoading, setReportLoading] = useState(false);
  const [reportVia, setReportVia] = useState<"AI" | "로컬" | "">("");
  const [reportDate, setReportDate] = useState("");
  const [reportWorker, setReportWorker] = useState<string | null>(null);

  // ── 욕구 분포 AI 분석 상태 ─────────────────────────────────────────
  // 프로그램별 Map으로 캐싱 → 탭 전환 시 즉시 이전 결과 표시 (재분석 전까지 불변)
  type NeedsEntry = { items: (NeedsDistItem & { fill: string })[]; date: string };
  const [needsDistCache, setNeedsDistCache] = useState<Map<string, NeedsEntry>>(new Map());
  const [aiNeedsLoading, setAiNeedsLoading] = useState(false);

  // 현재 프로그램+연도의 캐시 키
  const needsCacheKey = program === "밑반찬" ? "밑반찬" : `${program}_${needsYear}`;
  const aiNeedsDist = needsDistCache.get(needsCacheKey)?.items ?? null;
  const aiNeedsDate = needsDistCache.get(needsCacheKey)?.date ?? "";
  const [logYears, setLogYears] = useState<number[]>([curYear - 1, curYear]);
  const runNeedsDistAnalysis = useServerFn(analyzeNeedsDist);
  const runSideDishNeedsAnalysis = useServerFn(analyzeSideDishNeedsDist);
  const fetchCachedNeedsDist = useServerFn(getCachedNeedsDist);
  const fetchLogYears = useServerFn(getLogYears);

  const runReport = useServerFn(generateReport);
  const fetchCachedReport = useServerFn(getCachedReport);

  // org 로드 시 상담기록이 있는 연도 목록 조회 (드롭다운용)
  useEffect(() => {
    if (!org) return;
    fetchLogYears({ data: { orgId: org.id } })
      .then(({ years }) => {
        const merged = new Set([...years, curYear - 1, curYear]);
        setLogYears([...merged].sort((a, b) => b - a));
      })
      .catch(() => {}); // 실패 시 기본값(curYear-1, curYear) 유지
  }, [org?.id]);

  // 연도/기관/사업 변경 시 캐시 확인 → 없으면 자동 분석
  // Map 캐시 덕분에 이미 로드된 프로그램은 탭 전환 시 즉시 표시됨
  useEffect(() => {
    if (!org?.id) return;
    const orgId = org.id;
    const year = needsYear;
    const isSideDish = program === "밑반찬";
    const cacheKey = isSideDish ? "밑반찬" : `${program}_${year}`;
    const lsKey = isSideDish
      ? `needs_dist_v1_${orgId}_밑반찬`
      : program === "전체"
        ? `needs_dist_v1_${orgId}_${year}`
        : `needs_dist_v1_${orgId}_${year}_${program}`;
    const supabaseKey = isSideDish
      ? "sidedish_needs"
      : program === "전체"
        ? `needs_dist_전체_${year}`
        : `needs_dist_${program}_${year}`;

    // Map에 이미 있으면 즉시 표시 — 탭 재방문 시 기존 결과 유지
    if (needsDistCache.has(cacheKey)) { setAiNeedsLoading(false); return; }

    // Map에 없을 때만: localStorage → Supabase → AI 순으로 로드
    const setEntry = (top5: NeedsDistItem[], analyzedAt: string) => {
      const entry: NeedsEntry = { items: top5.map((d, i) => ({ ...d, fill: NEED_COLORS[i] })), date: analyzedAt };
      setNeedsDistCache((prev) => new Map(prev).set(cacheKey, entry));
    };

    // 1단계: localStorage 즉시 표시
    let hasCached = false;
    try {
      const cached = localStorage.getItem(lsKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { top5: NeedsDistItem[]; analyzedAt: string };
        if (parsed.top5?.length) { setEntry(parsed.top5, parsed.analyzedAt); hasCached = true; }
      }
    } catch { /* 손상된 캐시 무시 */ }

    if (hasCached) {
      setAiNeedsLoading(false);
      // 2단계: 백그라운드에서 Supabase 확인 (더 최신이면 Map 갱신)
      fetchCachedNeedsDist({ data: { orgId, reportKey: supabaseKey } })
        .then(({ cached: sc }) => {
          if (!sc?.top5?.length) return;
          setEntry(sc.top5, sc.analyzedAt);
          try { localStorage.setItem(lsKey, JSON.stringify({ top5: sc.top5, analyzedAt: sc.analyzedAt })); } catch { /* ignore */ }
        })
        .catch(() => {});
      return;
    }

    // 캐시 없음 → Supabase → AI
    setAiNeedsLoading(true);
    const runAnalysis = () => isSideDish
      ? runSideDishNeedsAnalysis({ data: { orgId } })
      : runNeedsDistAnalysis({ data: { year, orgId, program: program === "전체" ? undefined : program, reportKey: supabaseKey } });

    fetchCachedNeedsDist({ data: { orgId, reportKey: supabaseKey } })
      .then(({ cached: sc }) => {
        if (sc?.top5?.length) {
          setEntry(sc.top5, sc.analyzedAt);
          try { localStorage.setItem(lsKey, JSON.stringify({ top5: sc.top5, analyzedAt: sc.analyzedAt })); } catch { /* ignore */ }
          setAiNeedsLoading(false);
          return;
        }
        runAnalysis()
          .then((result) => {
            if (result.ok && result.top5.length > 0) {
              const analyzedAt = new Date().toISOString();
              setEntry(result.top5, analyzedAt);
              try { localStorage.setItem(lsKey, JSON.stringify({ top5: result.top5, analyzedAt })); } catch { /* ignore */ }
            }
          })
          .catch(() => {})
          .finally(() => setAiNeedsLoading(false));
      })
      .catch(() => {
        runAnalysis()
          .then((result) => {
            if (result.ok && result.top5.length > 0) {
              const analyzedAt = new Date().toISOString();
              setEntry(result.top5, analyzedAt);
              try { localStorage.setItem(lsKey, JSON.stringify({ top5: result.top5, analyzedAt })); } catch { /* ignore */ }
            }
          })
          .catch(() => {})
          .finally(() => setAiNeedsLoading(false));
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id, needsYear, program]);

  // org/program 변경 시 리포트 캐시 불러오기
  // 1단계: localStorage(빠른 초기 표시) → 2단계: Supabase 공유 캐시(조직 내 공유)
  useEffect(() => {
    if (!org?.id) return;
    const orgId = org.id;
    // 사업별 localStorage 키 + Supabase report_key
    const lsKey = program === "전체"
      ? `overview_report_v1_${orgId}`
      : `overview_report_v1_${orgId}_${program}`;
    const reportKey = program === "전체" ? "overview_report" : `overview_report_${program}`;

    // 초기화 (탭 전환 시 이전 결과 잔류 방지)
    setAiReport("");
    setReportVia("");
    setReportDate("");
    setReportWorker(null);

    // 1단계: localStorage 즉시 표시
    try {
      const cached = localStorage.getItem(lsKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { report: string; via: "AI" | "로컬"; analyzedAt: string; workerName?: string };
        setAiReport(parsed.report);
        setReportVia(parsed.via);
        setReportDate(parsed.analyzedAt);
        setReportWorker(parsed.workerName ?? null);
      }
    } catch {}

    // 2단계: Supabase 공유 캐시 확인 (다른 사용자 분석 결과 포함)
    fetchCachedReport({ data: { orgId, reportKey } })
      .then(({ cached }) => {
        if (!cached) return;
        setAiReport(cached.report);
        setReportVia(cached.via);
        setReportDate(cached.analyzedAt);
        setReportWorker(cached.workerName ?? null);
        // localStorage도 최신화
        try {
          localStorage.setItem(lsKey, JSON.stringify({
            report: cached.report, via: cached.via,
            analyzedAt: cached.analyzedAt, workerName: cached.workerName,
          }));
        } catch {}
      })
      .catch(() => {}); // 테이블 미존재 등 오류 시 localStorage 결과 유지
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id, program]);

  // 수동 재분석 (재분석 버튼 클릭 시 호출) — 사업별로 분기
  async function runNeedsAnalysis() {
    if (!org) return;
    const orgId = org.id;
    const year = needsYear;
    const isSideDish = program === "밑반찬";
    const lsKey = isSideDish
      ? `needs_dist_v1_${orgId}_밑반찬`
      : program === "전체"
        ? `needs_dist_v1_${orgId}_${year}`
        : `needs_dist_v1_${orgId}_${year}_${program}`;
    const supabaseKey = isSideDish
      ? "sidedish_needs"
      : program === "전체"
        ? `needs_dist_전체_${year}`
        : `needs_dist_${program}_${year}`;
    const currentCacheKey = needsCacheKey; // 클릭 시점 값 고정 — AI 호출 중 탭/연도 변경 시 구식 키에 저장 방지

    setAiNeedsLoading(true);
    try {
      const result = isSideDish
        ? await runSideDishNeedsAnalysis({ data: { orgId } })
        : await runNeedsDistAnalysis({ data: { year, orgId, program: program === "전체" ? undefined : program, reportKey: supabaseKey } });
      if (result.ok && result.top5.length > 0) {
        const analyzedAt = new Date().toISOString();
        try { localStorage.setItem(lsKey, JSON.stringify({ top5: result.top5, analyzedAt })); } catch {}
        setNeedsDistCache((prev) => new Map(prev).set(currentCacheKey, { items: result.top5.map((d, i) => ({ ...d, fill: NEED_COLORS[i] })), date: analyzedAt }));
        const label = isSideDish ? "밑반찬 실태조사" : `${year}년 상담기록`;
        toast.success(`${label} 욕구 분포 분석 완료`);
      } else {
        toast.error(result.error ?? "분석 결과가 없습니다.");
      }
    } catch (e) {
      toast.error("욕구 분석 실패: " + (e instanceof Error ? e.message : "오류"));
    } finally {
      setAiNeedsLoading(false);
    }
  }

  const [showUncontacted, setShowUncontacted] = useState(false);
  const [showNoConsent, setShowNoConsent] = useState(false);
  const [needDialogNeed, setNeedDialogNeed] = useState<string | null>(null);

  // 프로그램 탭 변경 시 다이얼로그 닫기
  useEffect(() => {
    setShowUncontacted(false);
    setShowNoConsent(false);
  }, [program]);

  const workers = useMemo(() => workerRoster(clients), [clients]);
  const programCounts = useMemo(() => {
    const acc: Record<string, number> = { 전체: 0, 사례관리: 0, 밑반찬: 0, 무료급식: 0 };
    clients.filter((c) => !isTerminated(c)).forEach((c) => {
      acc.전체++;
      programsOf(c).forEach((p) => { acc[p] = (acc[p] ?? 0) + 1; });
    });
    return acc;
  }, [clients]);

  const scoped = useMemo(
    () => clients.filter((c) => matchesScope(c, program, careFilter, workerFilter)),
    [clients, program, careFilter, workerFilter],
  );

  // ── AI 동의서 업로드 현황 (전체 탭 전용) ────────────────────────────
  const consentStats = useMemo(() => {
    if (program !== "전체") return null;
    // 무료급식-only 대상자는 AI 기능 미사용 → 동의서 집계 제외
    const active = scoped.filter(
      (c) => !isTerminated(c) && !programsOf(c).every((p) => p === "무료급식"),
    );
    const uploaded = active.filter((c) => !!c.consent_drive_url).length;
    const missing = active
      .filter((c) => !c.consent_drive_url)
      .sort((a, b) => (a.worker_name ?? "").localeCompare(b.worker_name ?? "", "ko"));
    const pct = active.length ? Math.round((uploaded / active.length) * 100) : 0;
    return { total: active.length, uploaded, missing, pct };
  }, [scoped, program]);

  // ── 실질 최종접촉일: 상담기록 + 제공이력 통합 ──────────────────────
  // clients.last_contact_at 단독으로는 누락 가능 → activity_logs·provisions 전체 순회
  // (ClientsTab의 effectiveLastContact와 동일 패턴)
  const effectiveContactMap = useMemo(() => {
    const map = new Map<string, string>(); // clientId → YYYY-MM-DD 최신 접촉일
    const toDate = (iso: string) => iso.slice(0, 10); // ISO → YYYY-MM-DD
    const scopedIds = new Set(scoped.map((c) => c.id));

    // 1) activity_logs(상담기록) 기반 — 실제 상담 날짜 우선
    // logs는 정렬 보장 없으므로 전체 순회
    logs.forEach((l) => {
      if (!scopedIds.has(l.client_id)) return;
      const logDate = toDate(l.created_at);
      const existing = map.get(l.client_id);
      if (!existing || logDate > existing) map.set(l.client_id, logDate);
    });
    // 2) 제공이력 기반 — 더 최신이면 갱신
    provisions.forEach((p) => {
      if (!scopedIds.has(p.client_id)) return;
      const existing = map.get(p.client_id);
      if (!existing || p.provided_at > existing) {
        map.set(p.client_id, p.provided_at);
      }
    });
    // 3) 상담·제공이력 모두 없는 경우에만 last_contact_at 폴백
    scoped.forEach((c) => {
      if (!map.has(c.id) && c.last_contact_at) map.set(c.id, toDate(c.last_contact_at));
    });
    return map;
  }, [scoped, logs, provisions]);

  /** 클라이언트의 실질 미접촉 일수 (상담+제공이력 기준) */
  const effectiveDays = (clientId: string): number => {
    const d = effectiveContactMap.get(clientId);
    if (!d) return 9999;
    return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
  };

  // 무료급식-only 대상자 여부 판별 (전체 탭에서 미접촉 제외용)
  const isFreeMealOnly = (c: Client) =>
    programsOf(c).every((p) => p === "무료급식");

  // ── KPI ────────────────────────────────────────────────────────────
  const kpi = useMemo(() => {
    const high = scoped.filter((c) => c.risk === "고위험").length;
    // 전체 탭에서는 무료급식-only 대상자를 미접촉 집계에서 제외
    const uncontactedBase = program === "전체"
      ? scoped.filter((c) => !isFreeMealOnly(c))
      : scoped;
    const uncontacted = uncontactedBase.filter((c) => {
      const d = effectiveContactMap.get(c.id);
      if (!d) return true;
      return Math.floor((Date.now() - new Date(d).getTime()) / 86400000) >= 14;
    }).length;
    // 계획 달성률 (계획 있는 대상자만)
    let planSum = 0, planCount = 0;
    scoped.forEach((c) => {
      const r = clientPlanRate(c, logs, provisions, curYear, planLinks);
      if (r != null) { planSum += r; planCount++; }
    });
    const avgPlan = planCount ? Math.round(planSum / planCount) : null;
    return { total: scoped.length, high, uncontacted, avgPlan, planCount };
  }, [scoped, logs, provisions, planLinks, curYear, effectiveContactMap, program]);

  // ── 사례관리 계획 연도 목록 ─────────────────────────────────────────
  const planYears = useMemo(() => {
    const years = new Set<number>();
    scoped.forEach((c) => {
      const { reassessments } = splitNote(c.note);
      reassessments.forEach((r) => {
        if (r.carePlan?.year) years.add(r.carePlan.year);
      });
    });
    years.add(curYear);
    years.add(curYear - 1);
    return [...years].sort((a, b) => b - a);
  }, [scoped, curYear]);

  // ── 연도별 상담 기반 욕구 분포 — 연도 목록은 logYears(서버 조회) 사용
  const needsYears = logYears;

  // needsDist: AI 결과를 차트 공통 형식으로 변환 (value = count)
  const needsDist = useMemo(
    () => (aiNeedsDist ?? []).map((d) => ({ ...d, value: d.count })),
    [aiNeedsDist],
  );

  // ── 위험도 분포 (파이차트용) ────────────────────────────────────────
  const riskDist = useMemo(() => {
    const acc: Record<string, number> = {};
    RISK_LEVELS.forEach((r) => { acc[r] = 0; });
    scoped.forEach((c) => { acc[c.risk] = (acc[c.risk] ?? 0) + 1; });
    return RISK_LEVELS.filter((r) => acc[r] > 0).map((r) => ({
      name: r, value: acc[r], fill: RISK_COLORS[r] ?? "#94a3b8",
    }));
  }, [scoped]);

  // ── 사례관리 계획 진행 현황 ─────────────────────────────────────────
  const planData = useMemo(() => {
    const entries: {
      client: Client;
      rate: number;
      rowCount: number;
      need: string[];
      rowRates: { need: string; rate: number }[];
    }[] = [];
    scoped.forEach((c) => {
      const { reassessments } = splitNote(c.note);
      const plan = reassessments.find((r) => r.carePlan?.year === planYear)?.carePlan;
      if (!plan || !plan.rows.length) return;
      const rate = clientPlanRate(c, logs, provisions, planYear, planLinks) ?? 0;
      const clientYearLogIds = new Set(
        logs.filter((l) => l.client_id === c.id && toKstDate(l.created_at).startsWith(String(planYear))).map((l) => l.id),
      );
      const clientYearProvIds = new Set(
        provisions.filter((p) => p.client_id === c.id && p.provided_at.startsWith(String(planYear))).map((p) => p.id),
      );
      const need = plan.rows.map((r) => r.need).filter(Boolean);
      const clientYearLinks = planLinks.filter((l) => l.client_id === c.id && l.plan_year === planYear);
      const rowRates = plan.rows.map((row) => {
        const baseActions = [...row.selfPlan, ...row.workerPlan];
        const actions = overrideActionLinks(baseActions, clientYearLinks);
        const rr = actions.length
          ? Math.round(actions.reduce((s, a) => s + actionRate(a, clientYearLogIds, clientYearProvIds), 0) / actions.length)
          : 0;
        return { need: row.need, rate: rr };
      });
      entries.push({ client: c, rate, rowCount: plan.rows.length, need, rowRates });
    });
    entries.sort((a, b) => b.rate - a.rate);

    // 욕구 카테고리별 평균 달성률
    const needAcc: Record<string, { sum: number; count: number }> = {};
    entries.forEach((e) => {
      e.need.forEach((n) => {
        if (!needAcc[n]) needAcc[n] = { sum: 0, count: 0 };
        needAcc[n].sum += e.rate;
        needAcc[n].count += 1;
      });
    });
    const needRates = Object.entries(needAcc)
      .map(([n, { sum, count }]) => ({ need: n, avg: Math.round(sum / count), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    return { entries, needRates, total: scoped.length };
  }, [scoped, logs, provisions, planLinks, planYear]);

  // ── 담당자별 현황 ─────────────────────────────────────────────────
  const workerStats = useMemo(() => {
    const acc: Record<string, { clients: number; highRisk: number; uncontacted: number; planCount: number; planRateSum: number }> = {};
    scoped.forEach((c) => {
      const w = c.worker_name ?? "미배정";
      if (!acc[w]) acc[w] = { clients: 0, highRisk: 0, uncontacted: 0, planCount: 0, planRateSum: 0 };
      acc[w].clients++;
      if (c.risk === "고위험") acc[w].highRisk++;
      const d = effectiveContactMap.get(c.id);
      const days = d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : 9999;
      if (days >= 14) acc[w].uncontacted++;
      const r = clientPlanRate(c, logs, provisions, planYear, planLinks);
      if (r != null) { acc[w].planCount++; acc[w].planRateSum += r; }
    });
    return Object.entries(acc)
      .map(([name, d]) => ({
        name,
        clients: d.clients,
        highRisk: d.highRisk,
        uncontacted: d.uncontacted,
        avgPlan: d.planCount ? Math.round(d.planRateSum / d.planCount) : null,
        planCount: d.planCount,
      }))
      .sort((a, b) => b.clients - a.clients);
  }, [scoped, logs, provisions, planLinks, planYear, effectiveContactMap]);

  // ── 우선 조치 검토 ────────────────────────────────────────────────
  const todayActions = useMemo(
    () => {
      // 전체 탭에서는 무료급식-only 대상자 제외
      const base = program === "전체" ? scoped.filter((c) => !isFreeMealOnly(c)) : scoped;
      return base
        .map((c) => {
          const lastDateStr = effectiveContactMap.get(c.id) ?? null;
          const days = lastDateStr
            ? Math.max(0, Math.floor((Date.now() - new Date(lastDateStr).getTime()) / 86400000))
            : 9999;
          return { c, d: days, lastDate: lastDateStr };
        })
        .filter(({ c, d }) => c.risk === "고위험" || c.risk === "경고" || d >= 14)
        .sort((a, b) => b.d - a.d)
        .slice(0, 8);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scoped, effectiveContactMap, program],
  );

  // ── 서비스 공백: 계획 있지만 올해 제공이력 0건 ───────────────────
  const serviceGapClients = useMemo(() => {
    const yearStr = String(curYear);
    // 올해 제공이력 있는 대상자
    const provisionedIds = new Set(
      provisions.filter((p) => p.provided_at.startsWith(yearStr)).map((p) => p.client_id),
    );
    // 올해 상담기록 있는 대상자 (상담 = 서비스 접점으로 인정)
    const contactedIds = new Set(
      logs.filter((l) => toKstDate(l.created_at).startsWith(yearStr)).map((l) => l.client_id),
    );
    return scoped
      .filter((c) => {
        if (provisionedIds.has(c.id)) return false; // 올해 제공이력 있음
        if (contactedIds.has(c.id)) return false;   // 올해 상담기록 있음
        const { reassessments } = splitNote(c.note);
        return reassessments.some(
          (r) => r.carePlan && Number(r.carePlan.year) === curYear && r.carePlan.rows.length > 0,
        );
      })
      .sort((a, b) => (a.worker_name ?? "").localeCompare(b.worker_name ?? "", "ko"));
  }, [scoped, provisions, logs, curYear]);

  // ── 미접촉 대상자 전체 목록 (다이얼로그용) ─────────────────────────
  const uncontactedList = useMemo(
    () => {
      // 전체 탭에서는 무료급식-only 대상자 제외
      const base = program === "전체" ? scoped.filter((c) => !isFreeMealOnly(c)) : scoped;
      return base
        .map((c) => {
          const lastDateStr = effectiveContactMap.get(c.id) ?? null;
          const days = lastDateStr
            ? Math.max(0, Math.floor((Date.now() - new Date(lastDateStr).getTime()) / 86400000))
            : 9999;
          // 최신 접촉 유형 판별 — effectiveContactMap과 동일하게 logs·provisions 기반
          const latestLog = logs
            .filter((l) => l.client_id === c.id)
            .map((l) => toKstDate(l.created_at))
            .sort()
            .reverse()[0] ?? null;
          const latestProv = provisions
            .filter((p) => p.client_id === c.id)
            .map((p) => p.provided_at.slice(0, 10))
            .sort()
            .reverse()[0] ?? null;
          let contactType: "상담" | "제공이력" | "없음" = "없음";
          if (lastDateStr) {
            if (latestLog && latestProv) {
              contactType = latestProv > latestLog ? "제공이력" : "상담";
            } else if (latestLog) {
              contactType = "상담";
            } else if (latestProv) {
              contactType = "제공이력";
            }
          }
          return { c, days, lastDate: lastDateStr, contactType };
        })
        .filter(({ days }) => days >= 14)
        .sort((a, b) => b.days - a.days);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scoped, effectiveContactMap, provisions, program],
  );

  // ── 최근 상담기록 (날짜 내림차순) ────────────────────────────────────
  const recentLogs = useMemo(() => {
    const clientIds = new Set(scoped.map((c) => c.id));
    return logs
      .filter((l) => clientIds.has(l.client_id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [logs, scoped]);

  // ── 최근 제공이력 (소속 대상자, 날짜 내림차순) ─────────────────────
  const recentProvisions = useMemo(() => {
    const clientIds = new Set(scoped.map((c) => c.id));
    return provisions
      .filter((p) => clientIds.has(p.client_id))
      .sort((a, b) => b.provided_at.localeCompare(a.provided_at));
  }, [provisions, scoped]);

  // ── AI 리포트 ─────────────────────────────────────────────────────
  async function refreshReport() {
    setReportLoading(true);
    const lsKey = org
      ? program === "전체"
        ? `overview_report_v1_${org.id}`
        : `overview_report_v1_${org.id}_${program}`
      : null;
    try {
      logView({ action: "AI 리포트 생성", detail: program });
      const r = await runReport({ data: { program } });
      if (r.report) {
        const at = r.analyzedAt ?? new Date().toISOString();
        setAiReport(r.report);
        setReportVia("AI");
        setReportDate(at);
        setReportWorker(r.workerName ?? null);
        if (r.saveError) toast.error(`공유 저장 실패: ${r.saveError}`);
        if (lsKey) {
          try {
            localStorage.setItem(lsKey, JSON.stringify({ report: r.report, via: "AI", analyzedAt: at, workerName: r.workerName }));
          } catch {}
        }
        return;
      }
    } catch (err) {
      const m = (err as Error).message || "";
      if (/GEMINI_API_KEY missing/.test(m)) toast.message("AI 미연결(키 없음): 로컬 계산으로 생성합니다.");
      else toast.error("제미나이 오류: " + m.slice(0, 160));
    } finally {
      setReportLoading(false);
    }
    const local = buildLocalReport();
    const at = new Date().toISOString();
    setAiReport(local);
    setReportVia("로컬");
    setReportDate(at);
    setReportWorker(null);
    if (lsKey) {
      try { localStorage.setItem(lsKey, JSON.stringify({ report: local, via: "로컬", analyzedAt: at })); } catch {}
    }
  }
  function buildLocalReport(): string {
    const lines: string[] = [];
    lines.push("■ 현황 요약");
    lines.push(`- 관리 대상자 ${kpi.total}명 · 고위험군 ${kpi.high}명 · 미접촉(14일↑) ${kpi.uncontacted}명`);
    if (kpi.avgPlan != null) lines.push(`- ${curYear}년 사례관리 계획 평균 달성률 ${kpi.avgPlan}% (${kpi.planCount}명 기준)`);
    if (aiNeedsDist && aiNeedsDist.length) {
      lines.push(""); lines.push("■ 주요 욕구 TOP 5");
      aiNeedsDist.slice(0, 5).forEach((n) => lines.push(`- ${n.name}: ${n.count}건 (${n.pct}%)`));
    }
    if (todayActions.length) {
      lines.push(""); lines.push(`■ 우선 조치 검토 (${todayActions.length}명)`);
      todayActions.forEach(({ c, d }) => lines.push(`- ${c.name} (${c.risk}) · ${d}일 미접촉`));
    }
    lines.push(""); lines.push("■ 제언");
    if (kpi.uncontacted > 0) lines.push(`- 미접촉 ${kpi.uncontacted}명에 대한 안부 연락이 필요합니다.`);
    if (kpi.high > 0) lines.push(`- 고위험군 ${kpi.high}명은 즉시 개입·모니터링 대상입니다.`);
    if (planData.entries.length < kpi.total * 0.5)
      lines.push(`- 사례관리 대상자 중 계획서 미업로드 대상자가 있습니다. [재사정] 탭에서 업로드를 권장합니다.`);
    return lines.join("\n");
  }

  const nameOf = (id: string) => clients.find((c) => c.id === id)?.name ?? "-";

  const rateColor = (r: number) => r >= 80 ? "text-emerald-600" : r >= 40 ? "text-amber-500" : "text-red-500";
  const rateBadge = (r: number) =>
    r >= 80
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : r >= 40
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-red-50 text-red-600 border-red-200";

  // 계획 전체 평균
  const planAvg = planData.entries.length
    ? Math.round(planData.entries.reduce((s, e) => s + e.rate, 0) / planData.entries.length)
    : null;

  return (
    <div className="space-y-5">
      {/* 필터 */}
      <ScopeFilter
        program={program}
        onProgram={setProgram}
        care={careFilter}
        onCare={setCareFilter}
        worker={workerFilter}
        onWorker={setWorkerFilter}
        workers={workers}
        counts={programCounts}
      />

      {/* ── KPI 타일 ── */}
      <div className={`grid grid-cols-1 gap-3 ${
        program === "전체"
          ? "sm:grid-cols-2 lg:grid-cols-4"
          : program === "무료급식"
            ? "sm:grid-cols-1"
            : program === "밑반찬"
              ? "sm:grid-cols-2"
              : "sm:grid-cols-3"
      }`}>
        <KpiCard
          icon={<Users className="h-4 w-4 text-blue-500" />}
          label="전체 관리 대상자"
          value={kpi.total}
          sub={`중점 ${scoped.filter((c) => /중점|집중/.test(c.grade ?? "")).length}명 · 일반 ${scoped.filter((c) => !/중점|집중/.test(c.grade ?? "")).length}명`}
        />
        {/* 무료급식 탭에서는 미접촉 KPI 숨김 */}
        {program !== "무료급식" && (
          <KpiCard
            icon={<CalendarIcon className="h-4 w-4 text-amber-500" />}
            label={`미접촉 (14일↑)${program === "전체" ? " · 무료급식 제외" : ""}`}
            value={kpi.uncontacted}
            sub="클릭 시 대상자 목록"
            tone="amber"
            onClick={() => setShowUncontacted(true)}
          />
        )}
        {/* 밑반찬·무료급식 탭에서는 계획 달성률 KPI 숨김 */}
        {program !== "밑반찬" && program !== "무료급식" && (
          <KpiCard
            icon={<ClipboardList className="h-4 w-4 text-indigo-500" />}
            label={`${curYear}년 계획 달성률`}
            value={kpi.avgPlan != null ? `${kpi.avgPlan}%` : "—"}
            sub={kpi.avgPlan != null ? `계획 ${kpi.planCount}명 기준` : "계획서 없음"}
            tone={kpi.avgPlan != null ? (kpi.avgPlan >= 60 ? "green" : "amber") : undefined}
          />
        )}
        {/* 전체 탭에서만 AI 동의서 업로드 현황 표시 */}
        {consentStats && (
          <KpiCard
            icon={<FileText className="h-4 w-4 text-teal-500" />}
            label="AI 동의서 업로드율 · 무료급식 제외"
            value={`${consentStats.pct}%`}
            sub={`${consentStats.uploaded}명 완료 · 미업로드 ${consentStats.missing.length}명 클릭`}
            tone={consentStats.pct >= 80 ? "green" : consentStats.pct >= 40 ? "amber" : "red"}
            onClick={() => setShowNoConsent(true)}
          />
        )}
      </div>

      {/* ── 사례관리 계획 진행 현황 ── (사례관리·전체 선택 시에만 표시) */}
      {(program === "전체" || program === "사례관리") && <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-indigo-500" />
              사례관리 계획 진행 현황
            </CardTitle>
            <select
              value={planYear}
              onChange={(e) => { setPlanYear(Number(e.target.value)); setPlanClientId(""); }}
              className="text-sm border border-input rounded-md px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {planYears.map((y) => (
                <option key={y} value={y}>{y}년</option>
              ))}
            </select>
          </div>
          <CardDescription>
            재사정 기록지에서 추출한 계획서 기준 · {planYear}년 · 담당자 직접 연동 기준
            {planData.entries.length > 0 && ` · ${planData.entries.length}명 / 전체 ${kpi.total}명`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {planData.entries.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <ClipboardList className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">{planYear}년 계획서가 아직 없어요.</p>
              <p className="text-xs mt-1">[재사정] 탭에서 PDF를 업로드하면 자동으로 추출됩니다.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 divide-y lg:divide-y-0 lg:divide-x divide-border">
              {/* ─ 왼쪽: 대상자별 계획 달성률 ─ */}
              <div className="pb-4 lg:pb-0 lg:pr-6">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-semibold text-foreground">대상자별 계획 달성률</p>
                  <select
                    value={planClientId}
                    onChange={(e) => setPlanClientId(e.target.value)}
                    className="text-sm border border-input rounded-md px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary max-w-[150px] truncate"
                  >
                    <option value="">전체 평균</option>
                    {planData.entries.map((e) => (
                      <option key={e.client.id} value={e.client.id}><ClientName c={e.client} /></option>
                    ))}
                  </select>
                </div>

                {planClientId === "" ? (
                  /* 전체 평균 뷰 */
                  <div className="space-y-3">
                    <div className="text-center py-2">
                      <p className="text-5xl font-bold text-indigo-600">{planAvg}%</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {planData.entries.length}명 평균 달성률
                      </p>
                    </div>
                    <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                      {planData.entries.map((e) => (
                        <div
                          key={e.client.id}
                          className="flex items-center gap-2 cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5"
                          onClick={() => setPlanClientId(e.client.id)}
                        >
                          <span className="text-sm flex-1 truncate min-w-0"><ClientName c={e.client} /></span>
                          <span className="hidden sm:inline text-[10px] text-muted-foreground shrink-0 max-w-[4rem] truncate">{e.client.worker_name ?? "-"}</span>
                          <Progress value={e.rate} className="h-1.5 w-14 shrink-0" />
                          <span className={`text-xs font-semibold tabular-nums w-8 text-right shrink-0 ${rateColor(e.rate)}`}>
                            {e.rate}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  /* 개별 대상자 뷰 */
                  (() => {
                    const sel = planData.entries.find((e) => e.client.id === planClientId);
                    if (!sel) return null;
                    return (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold"><ClientName c={sel.client} /></span>
                          {/중점|집중/.test(sel.client.grade ?? "") && (
                            <Badge variant="outline" className="text-[10px] px-1 py-0 border-blue-300 text-blue-600">중점</Badge>
                          )}
                          <Badge variant="outline" className={`text-[10px] px-1 py-0 ${riskStyle[sel.client.risk] ?? ""}`}>
                            {sel.client.risk}
                          </Badge>
                          <span className="text-xs text-muted-foreground ml-auto">{sel.client.worker_name ?? "미배정"}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <Progress value={sel.rate} className="h-3 flex-1" />
                          <span className={`text-2xl font-bold shrink-0 ${rateColor(sel.rate)}`}>{sel.rate}%</span>
                        </div>
                        {sel.rowRates.length > 0 && (
                          <div className="grid grid-cols-2 gap-2">
                            {sel.rowRates.map((r, i) => (
                              <div key={i} className="rounded-md border border-border p-2 text-center">
                                <p className="text-[11px] text-muted-foreground truncate">{r.need || "욕구"}</p>
                                <p className={`text-lg font-bold mt-0.5 ${rateColor(r.rate)}`}>{r.rate}%</p>
                              </div>
                            ))}
                          </div>
                        )}
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <Info className="h-3 w-3" />
                          항목별 세부 내용은 [사례관리 계획 점검] 탭에서 확인하세요.
                        </p>
                      </div>
                    );
                  })()
                )}
              </div>

              {/* ─ 오른쪽: 담당자별 계획 달성률 + 욕구 영역별 ─ */}
              <div className="pt-4 lg:pt-0 lg:pl-6 space-y-4">
                <div>
                  <p className="text-sm font-semibold text-foreground mb-3">담당자별 계획 달성률</p>
                  {workerStats.filter((w) => w.avgPlan != null).length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-3">담당자별 계획 데이터 없음</p>
                  ) : (
                    <div className="space-y-2.5 max-h-48 overflow-y-auto pr-1">
                      {workerStats
                        .filter((w) => w.avgPlan != null)
                        .sort((a, b) => (b.avgPlan ?? 0) - (a.avgPlan ?? 0))
                        .map((w) => (
                          <div key={w.name} className="space-y-1">
                            <div className="flex items-center justify-between text-sm">
                              <span className="font-medium truncate">{w.name}</span>
                              <div className="flex items-center gap-2 shrink-0 ml-2">
                                <span className="text-xs text-muted-foreground">{w.planCount}명</span>
                                <span className={`text-sm font-bold ${rateColor(w.avgPlan!)}`}>{w.avgPlan}%</span>
                              </div>
                            </div>
                            <Progress value={w.avgPlan!} className="h-2" />
                          </div>
                        ))}
                    </div>
                  )}
                </div>

                {planData.needRates.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground mb-2">욕구 영역별 평균 달성률</p>
                    <div className="grid grid-cols-2 gap-2">
                      {planData.needRates.slice(0, 6).map((n) => (
                        <div
                          key={n.need}
                          className="rounded-md border border-border p-2 text-center cursor-pointer hover:bg-muted/50 transition-colors"
                          onClick={() => setNeedDialogNeed(n.need)}
                        >
                          <p className="text-[11px] text-muted-foreground truncate">{n.need}</p>
                          <p className={`text-lg font-bold mt-0.5 ${rateColor(n.avg)}`}>{n.avg}%</p>
                          <p className="text-[10px] text-muted-foreground">{n.count}명</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Info className="h-3 w-3" />
                  달성률은 담당자가 직접 연동한 상담기록·제공이력 기준입니다.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>}

      {/* ── 상담 · 제공 활동 추이 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            상담 · 제공 활동 추이
            <span className="text-xs font-normal text-muted-foreground">(최근 6개월)</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityTrendChart logs={recentLogs} provisions={recentProvisions} months={6} />
          <div className="flex items-center gap-4 justify-center text-xs text-muted-foreground mt-1">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-3 rounded-sm" style={{ background: "var(--chart-1)" }} /> 상담
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-3 rounded-sm" style={{ background: "var(--chart-2)" }} /> 제공
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── 주요 욕구 분포 + 담당자별 현황 ── */}
      <div className="grid grid-cols-12 gap-4">
        <Card className="col-span-12 lg:col-span-7">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                주요 욕구 분포 TOP 5
              </CardTitle>
              {/* 밑반찬 탭에서는 연도 selector 숨김 (실태조사 기반) */}
              {program !== "밑반찬" && (
                <div className="flex items-center gap-2">
                  <select
                    value={needsYear}
                    onChange={(e) => setNeedsYear(Number(e.target.value))}
                    className="text-sm border border-input rounded-md px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {needsYears.map((y) => (
                      <option key={y} value={y}>{y}년</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <CardDescription className="flex items-center gap-2 flex-wrap">
              <span>
                {program === "밑반찬"
                  ? "AI가 분석한 밑반찬 실태조사 기반 주요 욕구"
                  : program === "무료급식"
                    ? "AI가 분석한 무료급식 대상 재사정·종합의견 주요 욕구"
                    : program === "사례관리"
                      ? `AI가 분석한 ${needsYear}년 사례관리 상담기록 주요 욕구`
                      : `AI가 분석한 ${needsYear}년 상담기록 주요 욕구`}
              </span>
              <AiModelBadge />
              {aiNeedsDate && (
                <span className="text-xs text-muted-foreground">
                  분석일: {new Date(aiNeedsDate).toLocaleDateString("ko-KR")}
                  {" · "}
                  <button
                    className="underline hover:opacity-70 disabled:opacity-40"
                    disabled={aiNeedsLoading}
                    onClick={() => runNeedsAnalysis()}
                  >
                    재분석
                  </button>
                </span>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {aiNeedsLoading ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
                <div className="h-8 w-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
                <p className="text-sm">
                  {program === "밑반찬"
                    ? "AI가 실태조사를 분석하고 있어요..."
                    : "AI가 상담기록을 분석하고 있어요..."}
                </p>
              </div>
            ) : needsDist.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
                <BarChart3 className="h-8 w-8 opacity-30" />
                <p className="text-sm">
                  {program === "밑반찬"
                    ? "실태조사 기반 욕구 분포를 아직 분석하지 않았어요."
                    : `${needsYear}년 욕구 분포를 아직 분석하지 않았어요.`}
                </p>
                {org && (
                  <Button size="sm" onClick={() => runNeedsAnalysis()} disabled={aiNeedsLoading}>
                    AI 분석하기
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                {/* 파이차트: 고정 크기 컨테이너로 감싸 레이블 잘림 방지 */}
                <div className="shrink-0 w-[200px] h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={needsDist}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={75}
                        innerRadius={44}
                        paddingAngle={3}
                      >
                        {needsDist.map((d) => (
                          <Cell key={d.name} fill={d.fill} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(v: number, name: string) => [`${v}건`, name]}
                        contentStyle={{ fontSize: 12, borderRadius: 8 }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                {/* 범례: 숫자가 잘리지 않도록 min-w-0 + 고정폭 제거 */}
                <div className="flex-1 w-full space-y-2 min-w-0">
                  {needsDist.map((d) => (
                    <div key={d.name} className="flex items-center gap-2">
                      <span
                        className="h-3 w-3 rounded-sm shrink-0"
                        style={{ background: d.fill }}
                      />
                      <span className="text-sm truncate flex-1 min-w-0">{d.name}</span>
                      <span className="text-sm font-semibold shrink-0 tabular-nums"
                        title="해당 욕구가 언급된 대상자 수 (AI 추정)">{d.value}명</span>
                      <span className="text-xs text-muted-foreground shrink-0 tabular-nums min-w-[2.5rem] text-right">
                        {d.pct}%
                      </span>
                    </div>
                  ))}
                  <p className="text-[10px] text-muted-foreground pt-1">
                    * 명 수치는 기록 기반 AI 추정값입니다
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-12 lg:col-span-5">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <UserCheck className="h-4 w-4" />
              담당자별 현황
            </CardTitle>
          </CardHeader>
          <CardContent>
            {workerStats.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">데이터 없음</p>
            ) : (
              <div className="space-y-2">
                {workerStats.map((w) => {
                  return (
                  <div key={w.name} className="rounded-md border border-border p-2.5">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium text-sm flex items-center gap-1.5">
                        {w.name}
                      </span>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>
                          <span className="font-medium text-foreground">{w.clients}</span>명
                        </span>
                        {w.highRisk > 0 && (
                          <span className="text-red-600 font-medium">
                            고위험 {w.highRisk}
                          </span>
                        )}
                        {w.uncontacted > 0 && (
                          <span className="text-amber-600">미접촉 {w.uncontacted}</span>
                        )}
                      </div>
                    </div>
                    {w.avgPlan != null && (
                      <div className="flex items-center gap-2">
                        <Progress value={w.avgPlan} className="h-1.5 flex-1" />
                        <span className={`text-xs font-semibold w-10 text-right ${rateColor(w.avgPlan)}`}>
                          {w.avgPlan}%
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          ({w.planCount}명)
                        </span>
                      </div>
                    )}
                    {w.avgPlan == null && (
                      <p className="text-[11px] text-muted-foreground">계획서 없음</p>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── 우선 조치 + 최근 상담 ── */}
      <div className="grid grid-cols-12 gap-4">
        <Card className="col-span-12 lg:col-span-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarIcon className="h-4 w-4" />
              우선 조치 검토
            </CardTitle>
            <CardDescription>고위험 · 14일 이상 미접촉 대상자 (상담 + 제공이력 기준)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {todayActions.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                모든 대상자와 최근 접촉했습니다. 👏
              </p>
            ) : (
              <ul className="space-y-2">
                {todayActions.map(({ c, d, lastDate }) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between text-sm rounded-md border border-border px-3 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant="outline" className={`shrink-0 ${riskStyle[c.risk] ?? ""}`}>{c.risk}</Badge>
                      <span className="font-medium truncate"><ClientName c={c} /></span>
                      <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">{c.worker_name ?? "-"}</span>
                    </div>
                    <div className="text-right shrink-0 ml-2">
                      <div className={`text-xs font-medium ${d >= 30 ? "text-red-600" : "text-orange-500"}`}>
                        {d >= 9999 ? "접촉 없음" : `${d}일 전`}
                      </div>
                      {lastDate && (
                        <div className="text-[10px] text-muted-foreground">
                          {lastDate}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/* 서비스 공백: 계획 있지만 올해 제공이력 0건 */}
            {serviceGapClients.length > 0 && (
              <div className="pt-2 border-t border-border">
                <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                  <Package className="h-3 w-3" />
                  서비스 공백 — {curYear}년 계획 있으나 제공이력 없음 ({serviceGapClients.length}명)
                </p>
                <ul className="space-y-1">
                  {serviceGapClients.slice(0, 5).map((c) => (
                    <li key={c.id} className="flex items-center justify-between text-xs rounded border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 px-2 py-1">
                      <span className="font-medium"><ClientName c={c} /></span>
                      <span className="text-muted-foreground">{c.worker_name ?? "미배정"}</span>
                    </li>
                  ))}
                  {serviceGapClients.length > 5 && (
                    <li className="text-[11px] text-muted-foreground text-right">외 {serviceGapClients.length - 5}명</li>
                  )}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 최근 상담 기록 */}
        <Card className="col-span-12 lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              최근 상담 기록
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentLogs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">기록 없음</p>
            ) : (
              <ul className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {recentLogs.slice(0, 10).map((l) => (
                  <li key={l.id} className="text-sm border-b border-border pb-2 last:border-0">
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-0.5">
                      <span>{nameOf(l.client_id)} · {l.method} · {l.worker_name ?? "-"}</span>
                      <span className="shrink-0 ml-1">{new Date(l.created_at).toLocaleDateString("ko-KR")}</span>
                    </div>
                    <p className="line-clamp-2 text-sm">{l.note}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* 최근 제공이력 */}
        <Card className="col-span-12 lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Package className="h-4 w-4" />
              최근 제공이력
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentProvisions.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">기록 없음</p>
            ) : (
              <ul className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {recentProvisions.slice(0, 10).map((p) => (
                  <li key={p.id} className="text-sm border-b border-border pb-2 last:border-0">
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-0.5">
                      <span>{nameOf(p.client_id)} · {p.category}</span>
                      <span className="shrink-0 ml-1">{new Date(p.provided_at).toLocaleDateString("ko-KR")}</span>
                    </div>
                    <p className="line-clamp-1 text-sm font-medium">{p.title}</p>
                    {(p.quantity || p.agency) && (
                      <p className="text-xs text-muted-foreground">
                        {[p.quantity, p.agency].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── 슈퍼비전 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" />
            {program === "전체"
              ? "사례관리 20년차의 슈퍼비전"
              : `사례관리 20년차의 슈퍼비전 · ${program}`}
            <AiModelBadge />
          </CardTitle>
          <CardDescription>
            {program === "사례관리"
              ? "상담내용 · 제공이력 · 재사정 내용 기반 — 본 것 · 깨달은 것 · 적용할 점"
              : program === "밑반찬"
                ? "밑반찬 제공이력 · 실태조사 기반 — 본 것 · 깨달은 것 · 적용할 점"
                : program === "무료급식"
                  ? "무료급식 분류 대상 상담기록 기반 — 본 것 · 깨달은 것 · 적용할 점"
                  : "본 것 · 깨달은 것 · 적용할 점 — 현장 데이터 기반 슈퍼비전"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {aiReport ? (
            <>
              <div className="text-sm whitespace-pre-wrap p-3 bg-accent/40 rounded-md border border-border">
                {aiReport}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {reportVia && (
                  <Badge variant="outline" className="text-[10px]">
                    {reportVia === "AI" ? "AI(제미나이)" : "앱 내 계산"}
                  </Badge>
                )}
                {reportDate && (
                  <span>
                    {reportWorker ? `${reportWorker} · ` : ""}
                    {new Date(reportDate).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })} 분석
                  </span>
                )}
                <button
                  type="button"
                  onClick={refreshReport}
                  disabled={reportLoading}
                  className="ml-auto text-xs underline underline-offset-2 text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {reportLoading ? "생성 중..." : "다시 받기"}
                </button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={refreshReport} disabled={reportLoading}>
                {reportLoading ? "생성 중..." : "슈퍼비전 받기"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 욕구 영역별 달성률 대상자 다이얼로그 ── */}
      <Dialog open={!!needDialogNeed} onOpenChange={(o) => { if (!o) setNeedDialogNeed(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Target className="h-4 w-4 text-blue-500" />
              {needDialogNeed} 달성 현황
              <Badge variant="secondary" className="ml-1">
                {needDialogNeed
                  ? planData.entries.filter((e) => e.need.includes(needDialogNeed)).length
                  : 0}명
              </Badge>
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground -mt-2 pb-1">
            해당 욕구 영역의 서비스 목표를 가진 대상자 목록 (달성률 높은 순)
          </p>
          {(() => {
            if (!needDialogNeed) return null;
            const rows = planData.entries
              .filter((e) => e.need.includes(needDialogNeed))
              .map((e) => ({
                client: e.client,
                overallRate: e.rate,
                needRate: e.rowRates.find((r) => r.need === needDialogNeed)?.rate ?? null,
              }))
              .sort((a, b) => (b.needRate ?? 0) - (a.needRate ?? 0));
            if (rows.length === 0) {
              return (
                <p className="text-sm text-muted-foreground text-center py-8">
                  해당 영역의 대상자가 없습니다.
                </p>
              );
            }
            return (
              <div className="space-y-1 max-h-[60dvh] overflow-y-auto pr-1">
                {rows.map(({ client: c, overallRate, needRate }) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <Badge variant="outline" className={`shrink-0 text-[10px] ${riskStyle[c.risk] ?? ""}`}>
                      {c.risk}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium truncate"><ClientName c={c} /></span>
                        <span className="text-xs text-muted-foreground shrink-0">{c.worker_name ?? "미배정"}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        전체 달성률 {overallRate}%
                      </div>
                    </div>
                    <span className={`text-sm font-bold shrink-0 tabular-nums ${needRate !== null ? rateColor(needRate) : "text-muted-foreground"}`}>
                      {needRate !== null ? `${needRate}%` : "—"}
                    </span>
                  </div>
                ))}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ── 미접촉 대상자 다이얼로그 ── */}
      <Dialog open={showUncontacted} onOpenChange={setShowUncontacted}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarIcon className="h-4 w-4 text-amber-500" />
              미접촉 대상자 목록
              <Badge variant="secondary" className="ml-1">{uncontactedList.length}명</Badge>
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground -mt-2 pb-1">
            상담기록·제공이력 모두 포함한 최종 접촉일 기준 14일 이상 미접촉
          </p>
          {uncontactedList.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              모든 대상자와 최근 접촉했습니다. 👏
            </p>
          ) : (
            <div className="space-y-1 max-h-[60dvh] overflow-y-auto pr-1">
              {uncontactedList.map(({ c, days, lastDate, contactType }) => (
                <div
                  key={c.id}
                  className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <Badge variant="outline" className={`shrink-0 text-[10px] ${riskStyle[c.risk] ?? ""}`}>
                    {c.risk}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium truncate"><ClientName c={c} /></span>
                      <span className="text-xs text-muted-foreground shrink-0">{c.worker_name ?? "미배정"}</span>
                    </div>
                    {lastDate ? (
                      <div className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                        {contactType === "상담" ? (
                          <MessageSquare className="h-3 w-3" />
                        ) : contactType === "제공이력" ? (
                          <Package className="h-3 w-3" />
                        ) : null}
                        <span>마지막 {contactType}: {lastDate}</span>
                      </div>
                    ) : (
                      <div className="text-[11px] text-muted-foreground mt-0.5">접촉 기록 없음</div>
                    )}
                  </div>
                  <span className="text-xs font-semibold text-orange-600 shrink-0 tabular-nums">
                    {days >= 9999 ? "—" : `${days}일`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── AI 동의서 미업로드 대상자 다이얼로그 ── */}
      {consentStats && (
        <Dialog open={showNoConsent} onOpenChange={setShowNoConsent}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-teal-500" />
                AI 동의서 미업로드 대상자
                <Badge variant="secondary" className="ml-1">{consentStats.missing.length}명</Badge>
              </DialogTitle>
            </DialogHeader>
            <p className="text-xs text-muted-foreground -mt-2 pb-1">
              대상자 상세 → "AI 기능 동의서 업로드" 버튼으로 업로드할 수 있어요
            </p>
            {consentStats.missing.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                모든 대상자의 동의서가 업로드됐습니다. 🎉
              </p>
            ) : (
              <div className="space-y-1 max-h-[60dvh] overflow-y-auto pr-1">
                {consentStats.missing.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <Badge variant="outline" className={`shrink-0 text-[10px] ${riskStyle[c.risk] ?? ""}`}>
                      {c.risk}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <span className="font-medium truncate"><ClientName c={c} /></span>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {c.worker_name ?? "미배정"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ── KPI 타일 컴포넌트 ─────────────────────────────────────────────────
function KpiCard({
  icon,
  label,
  value,
  sub,
  tone,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: "red" | "amber" | "green";
  onClick?: () => void;
}) {
  const toneClass =
    tone === "red"
      ? "text-red-600"
      : tone === "amber"
        ? "text-amber-600"
        : tone === "green"
          ? "text-emerald-600"
          : "text-foreground";
  return (
    <Card className={onClick ? "cursor-pointer hover:bg-accent/30 transition-colors" : ""} onClick={onClick}>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
          {icon}
          {label}
        </div>
        <div className={`text-2xl font-bold ${toneClass} ${onClick ? "underline-offset-2 hover:underline" : ""}`}>
          {value}
        </div>
        {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}
