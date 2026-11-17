import { ClientName } from "@/components/NameMask";
import { toKstDate } from "@/lib/log-time";
import { useCallback, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Search,
  ChevronsUpDown,
  ClipboardList,
  ChevronDown,
  ChevronUp,
  Pencil,
  CheckCircle2,
  CircleDashed,
  BookOpen,
  Package,
  RefreshCw,
  MessageSquare,
  Plus,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Users,
  Trash2,
} from "lucide-react";
import {
  splitNote,
  joinNote,
  getActiveCarePlanActions,
  careLevelOf,
  careLevelStyle,
  programsOf,
  programStyle,
  hasCareLevel,
  isTerminated,
  workerRoster,
  PROVISION_CATEGORIES,
  type Client,
  type ActivityLog,
  type Provision,
  type CarePlan,
  type CarePlanAction,
  type CarePlanRow,
  type ActiveAction,
} from "@/lib/case-types";
import { insertCarePlanActionLinks, deleteCarePlanActionLinks, deleteLinksForAction, yearMapOf, applyLinksToActions, overrideActionLinks, type CarePlanLinkRow } from "@/lib/care-plan-links";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useClientViewLog } from "@/lib/use-client-view-log";

// ── Props ────────────────────────────────────────────────────────────
type Props = {
  clients: Client[];
  logs: ActivityLog[];
  provisions: Provision[];
  onChanged: () => void;
  canWrite?: boolean;
  planLinks?: CarePlanLinkRow[];
};

// ── 달성률 계산 ──────────────────────────────────────────────────────
type Evidence = { id: string; date: string; note: string; evidenceType?: "log" | "provision" };

function computeActionResult(
  action: CarePlanAction,
  allEvidence: Evidence[],
): { achievedCount: number; rate: number; evidence: Evidence[] } {
  // 담당자가 직접 연동한 항목만 근거로 사용 (키워드 자동 매칭 제거)
  const linkedIds = new Set([
    ...(action.linkedLogIds ?? []),
    ...(action.linkedProvIds ?? []),
  ]);
  const evidence = allEvidence.filter((e) => linkedIds.has(e.id));

  if (action.manualRate != null) {
    return { achievedCount: -1, rate: action.manualRate, evidence };
  }
  const achievedCount = evidence.length;
  const rate = action.targetCount
    ? Math.min(100, Math.round((achievedCount / action.targetCount) * 100))
    : Math.min(100, achievedCount * 25);
  return { achievedCount, rate, evidence };
}

/** CarePlanRow 전체 달성률 = 모든 action 평균 */
function rowRate(row: CarePlanRow, logs: Evidence[]): number {
  const actions = [...row.selfPlan, ...row.workerPlan];
  if (actions.length === 0) return 0;
  const sum = actions.reduce(
    (s, a) => s + computeActionResult(a, logs).rate,
    0,
  );
  return Math.round(sum / actions.length);
}

/** CarePlan 전체 달성률 */
function planRate(plan: CarePlan, logs: Evidence[]): number {
  if (plan.rows.length === 0) return 0;
  const sum = plan.rows.reduce((s, row) => s + rowRate(row, logs), 0);
  return Math.round(sum / plan.rows.length);
}

// ── 색상 헬퍼 ───────────────────────────────────────────────────────
function rateColor(rate: number): string {
  if (rate >= 80) return "text-green-600";
  if (rate >= 50) return "text-yellow-600";
  if (rate > 0)   return "text-orange-500";
  return "text-red-500";
}
// Tailwind 정적 클래스 매핑 — 동적 템플릿 리터럴 사용 시 프로덕션 빌드에서 purge됨
const RATE_BG = {
  great: "[&>div]:bg-green-500",
  good:  "[&>div]:bg-yellow-400",
  mid:   "[&>div]:bg-orange-400",
  low:   "[&>div]:bg-red-400",
} as const;
function rateKey(rate: number): keyof typeof RATE_BG {
  return rate >= 80 ? "great" : rate >= 50 ? "good" : rate > 0 ? "mid" : "low";
}

// ── PlanEntry (계획이 있는 대상자 데이터) ────────────────────────────
type PlanEntry = {
  client: Client;
  reassessedAt: string;
  plan: CarePlan;
  yearLogs: Evidence[];      // 상담기록
  yearProvs: Evidence[];     // 제공이력
  allEvidence: Evidence[];   // 상담+제공 합산 (달성률 계산용)
};

/** 재사정 배열에서 해당 재사정 인덱스를 찾는다.
 *  reassessedAt이 있으면 그 값으로, 없으면 carePlan.year로 fallback 매칭.
 *  (재사정 문서에 날짜가 없어 reassessedAt이 추출되지 않은 경우를 커버) */
function findReassessmentIdx(
  reassessments: import("@/lib/case-types").Reassessment[],
  reassessedAt: string,
  planYear: number,
): number {
  if (reassessedAt) {
    const byDate = reassessments.findIndex((r) => r.reassessedAt === reassessedAt);
    if (byDate >= 0) return byDate;
  }
  // reassessedAt 미설정 혹은 매칭 실패 → 같은 연도 carePlan으로 fallback
  return reassessments.findIndex(
    (r) => !r.reassessedAt && Number(r.carePlan?.year) === planYear,
  );
}

// ── ManualEdit 다이얼로그 상태 ───────────────────────────────────────
type ManualEditTarget = {
  clientId: string;
  reassessedAt: string;
  planYear: number;
  rowId: string;
  action: CarePlanAction;
  role: "self" | "worker";
  currentEvidence: Evidence[];
};

// ── 액션 아이템 공유 콜백 타입 ────────────────────────────────────────
/** 연동 해제: care_plan_action_links 표에서 해당 상담기록·제공이력의 연결을 지운다(실패하면 예외) */
type UnlinkCallback = (clientId: string, actionId: string, kind: "log" | "prov", linkedId: string) => Promise<void>;

type ActionItemShared = {
  provisions: Provision[];
  onUnlink: UnlinkCallback;
  onOpenLog: (id: string, note: string) => void;
  onOpenProv: (prov: Provision) => void;
  onManualEdit: (
    entry: PlanEntry,
    rowId: string,
    action: CarePlanAction,
    role: "self" | "worker",
  ) => void;
  onEditAction: (
    entry: PlanEntry,
    rowId: string,
    action: CarePlanAction,
    role: "self" | "worker",
  ) => void;
  onAddProvFromManual: (
    entry: PlanEntry,
    rowId: string,
    action: CarePlanAction,
    role: "self" | "worker",
  ) => void;
  onDeleteAction: (
    entry: PlanEntry,
    rowId: string,
    action: CarePlanAction,
    role: "self" | "worker",
  ) => void;
  onMoveAction: (
    entry: PlanEntry,
    rowId: string,
    action: CarePlanAction,
    role: "self" | "worker",
    dir: "up" | "down",
  ) => void;
  onAddAction: (entry: PlanEntry, rowId: string, role: "self" | "worker") => void;
  onEditRow: (entry: PlanEntry, row: CarePlanRow) => void;
  canWrite: boolean;
};

// ── ActionItem — 모듈 레벨 정의 (ServiceGoalsTab 밖) ──────────────────
// 내부 정의 시 부모 리렌더마다 unmount/remount되어 state가 초기화되는 버그 방지
function ActionItem({
  action,
  entry,
  rowId,
  role,
  index,
  total,
  shared,
}: {
  action: CarePlanAction;
  entry: PlanEntry;
  rowId: string;
  role: "self" | "worker";
  index: number;
  total: number;
  shared: ActionItemShared;
}) {
  const { provisions, onUnlink, onOpenLog, onOpenProv, onManualEdit, onEditAction, onAddProvFromManual, onDeleteAction, onMoveAction, canWrite } = shared;
  const result = computeActionResult(action, entry.allEvidence);
  const isManual = action.manualRate != null;
  const [busy, setBusy] = useState(false);

  const logEvidence = result.evidence.filter((e) => e.evidenceType !== "provision");
  const provEvidence = result.evidence.filter((e) => e.evidenceType === "provision");

  // 연동 해제: care_plan_action_links 표에서 해당 연결 제거
  async function unlinkItem(id: string, type: "log" | "provision") {
    setBusy(true);
    try {
      await onUnlink(entry.client.id, action.id, type === "log" ? "log" : "prov", id);
    } catch {
      toast.error("연동 해제 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-2 flex-wrap">
        <span className="text-sm flex-1 min-w-0 leading-snug">
          {action.text}
          {action.targetCount && action.unit && (
            <span className="ml-1 text-xs text-muted-foreground">
              (목표: {action.targetCount}{action.unit})
            </span>
          )}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {isManual && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 text-muted-foreground">
              수동
            </Badge>
          )}
          <span className={`text-xs font-semibold w-10 text-right ${rateColor(result.rate)}`}>
            {result.rate}%
          </span>
          {!isManual && result.achievedCount >= 0 && action.targetCount && (
            <span className="text-[10px] text-muted-foreground">
              ({result.achievedCount}/{action.targetCount}{action.unit ?? "회"})
            </span>
          )}
          {canWrite && (
            <>
              <Button
                size="icon" variant="ghost" className="h-5 w-5" title="위로 이동"
                onClick={() => onMoveAction(entry, rowId, action, role, "up")}
                disabled={index === 0 || busy}
              >
                <ArrowUp className="h-3 w-3" />
              </Button>
              <Button
                size="icon" variant="ghost" className="h-5 w-5" title="아래로 이동"
                onClick={() => onMoveAction(entry, rowId, action, role, "down")}
                disabled={index === total - 1 || busy}
              >
                <ArrowDown className="h-3 w-3" />
              </Button>
              <Button
                size="icon" variant="ghost" className="h-5 w-5" title="행동계획 수정"
                onClick={() => onEditAction(entry, rowId, action, role)}
                disabled={busy}
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                size="icon" variant="ghost"
                className="h-5 w-5 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                title="삭제"
                onClick={() => onDeleteAction(entry, rowId, action, role)}
                disabled={busy}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </>
          )}
        </div>
      </div>
      <Progress value={result.rate} className={`h-1.5 ${RATE_BG[rateKey(result.rate)]}`} />

      {/* 수동 메모 (텍스트만 표시) */}
      {action.manualNote && (
        <p className="text-[11px] text-muted-foreground pl-0.5 italic">
          메모: {action.manualNote}
        </p>
      )}

      {/* 연결된 상담기록 칩 (상담기록 작성 시 체크한 항목만 표시) */}
      {logEvidence.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pl-0.5">
          {logEvidence.map((ev) => (
            <span
              key={ev.id}
              className="inline-flex items-center gap-0.5 rounded border border-border bg-background pl-1.5 pr-0.5 py-0.5 text-[11px] text-muted-foreground max-w-[240px]"
            >
              <MessageSquare className="h-2.5 w-2.5 text-primary/60 shrink-0" />
              <button
                type="button"
                className="truncate hover:text-foreground hover:underline"
                title={ev.note}
                onClick={() => onOpenLog(ev.id, ev.note)}
              >
                {ev.date} {ev.note.length > 28 ? ev.note.slice(0, 28) + "…" : ev.note}
              </button>
              {canWrite && (
                <button
                  type="button"
                  className="shrink-0 rounded-sm p-0.5 hover:bg-red-100 hover:text-red-600 ml-0.5"
                  title="이 상담기록 연동 해제"
                  onClick={() => unlinkItem(ev.id, "log")}
                  disabled={busy}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* 연결된 제공이력 칩 + 새 제공이력 등록 (제공이력 추가 시 체크한 항목만 표시) */}
      <div className="flex flex-wrap items-center gap-1 pl-0.5">
          {provEvidence.map((ev) => (
            <span
              key={ev.id}
              className="inline-flex items-center gap-0.5 rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/30 pl-1.5 pr-0.5 py-0.5 text-[11px] text-indigo-700 dark:text-indigo-300 max-w-[260px]"
            >
              <Package className="h-2.5 w-2.5 shrink-0" />
              <button
                type="button"
                className="truncate hover:underline"
                title={ev.note}
                onClick={() => {
                  const prov = provisions.find((p) => p.id === ev.id);
                  if (prov) onOpenProv(prov);
                }}
              >
                {ev.date} {ev.note.length > 32 ? ev.note.slice(0, 32) + "…" : ev.note}
              </button>
              {canWrite && (
                <button
                  type="button"
                  className="shrink-0 rounded-sm p-0.5 hover:bg-red-100 hover:text-red-600 ml-0.5"
                  title="이 제공이력 연동 해제"
                  onClick={() => unlinkItem(ev.id, "provision")}
                  disabled={busy}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </span>
          ))}
          {/* 새 제공이력 등록 */}
          {canWrite && (
            <Button
              size="sm" variant="ghost"
              className="h-5 px-1.5 text-[11px] text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 gap-0.5"
              onClick={() => onAddProvFromManual(entry, rowId, action, role)}
              disabled={busy}
            >
              <Plus className="h-3 w-3" />새 제공이력
            </Button>
          )}
        </div>
    </div>
  );
}

// ── RatedEntry (달성률 미리 계산) ─────────────────────────────────────
type RatedEntry = PlanEntry & { rate: number };

// ── 컴포넌트 ────────────────────────────────────────────────────────
export function ServiceGoalsTab({ clients, logs, provisions, onChanged, canWrite = true, planLinks = [] }: Props) {
  const curYear = new Date().getFullYear();
  const [yearFilter, setYearFilter] = useState(curYear);
  const [workerFilter, setWorkerFilter] = useState("전체");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selfSectionOpen, setSelfSectionOpen] = useState(true);
  const [workerSectionOpen, setWorkerSectionOpen] = useState(true);
  const [manualEdit, setManualEdit] = useState<ManualEditTarget | null>(null);
  const [manualRate, setManualRate] = useState(0);
  const [manualNote, setManualNote] = useState("");
  const [saving, setSaving] = useState(false);
  // 근거 상담기록 상세보기·수정 다이얼로그
  const [logDetailId, setLogDetailId] = useState<string | null>(null);
  const [logEditText, setLogEditText] = useState("");
  const [logEditMode, setLogEditMode] = useState(false);
  const [logEditBusy, setLogEditBusy] = useState(false);
  // 제공이력 상세보기·수정 다이얼로그
  const [provDetailId, setProvDetailId] = useState<string | null>(null);
  const [provEditMode, setProvEditMode] = useState(false);
  const [provEditBusy, setProvEditBusy] = useState(false);
  const [provEditFields, setProvEditFields] = useState<{
    provided_at: string; category: string; title: string;
    quantity: string; agency: string; note: string;
  } | null>(null);
  // 동기화 상태
  const [syncing, setSyncing] = useState(false);
  // 행동계획 텍스트 수정 다이얼로그
  const [actionEdit, setActionEdit] = useState<{
    clientId: string; reassessedAt: string; planYear: number; rowId: string;
    action: CarePlanAction; role: "self" | "worker";
  } | null>(null);
  const [actionEditText, setActionEditText] = useState("");
  const [actionEditTarget, setActionEditTarget] = useState("");
  const [actionEditUnit, setActionEditUnit] = useState("");
  const [actionEditBusy, setActionEditBusy] = useState(false);
  // 우선순위 편집 다이얼로그
  const [rowEdit, setRowEdit] = useState<{
    clientId: string; reassessedAt: string; planYear: number; rowId: string;
  } | null>(null);
  const [rowEditPriority, setRowEditPriority] = useState("");
  const [rowEditNeed, setRowEditNeed] = useState("");
  const [rowEditBusy, setRowEditBusy] = useState(false);
  const [rowDeleteConfirm, setRowDeleteConfirm] = useState(false);
  // 행동계획 추가 다이얼로그
  const [addAction, setAddAction] = useState<{
    clientId: string; reassessedAt: string; planYear: number; rowId: string; role: "self" | "worker";
  } | null>(null);
  const [addActionText, setAddActionText] = useState("");
  const [addActionCount, setAddActionCount] = useState("");
  const [addActionUnit, setAddActionUnit] = useState("");
  const [addActionBusy, setAddActionBusy] = useState(false);
  // 제공이력 추가 폼
  const [provFormTarget, setProvFormTarget] = useState<{
    clientId: string; orgId: string;
    action: CarePlanAction; rowId: string; role: "self" | "worker"; reassessedAt: string;
  } | null>(null);
  // 제공이력 폼에서 선택한 계획 항목 IDs (다중 선택)
  const [provSelectedIds, setProvSelectedIds] = useState<Set<string>>(new Set());
  const [provFields, setProvFields] = useState<{
    category: typeof PROVISION_CATEGORIES[number];
    title: string; quantity: string; agency: string; note: string; provided_at: string;
  }>({
    category: PROVISION_CATEGORIES[0], title: "", quantity: "", agency: "", note: "", provided_at: "",
  });
  const [provFormBusy, setProvFormBusy] = useState(false);
  // ── UI 개선: 달성률 필터 / 정렬 / 그룹핑 ──────────────────────────
  const [rateFilter, setRateFilter] = useState<"전체" | "우수" | "보통" | "미달" | "zero">("전체");
  const [rateSortDir, setRateSortDir] = useState<"desc" | "asc" | null>(null);
  const [groupByWorker, setGroupByWorker] = useState(false);

  const workers = useMemo(() => workerRoster(clients), [clients]);

  // 연도 옵션: 계획서가 실제 존재하는 연도 + 올해 (올해는 새 계획서 작성용으로 항상 포함)
  const yearOptions = useMemo(() => {
    const years = new Set<number>();
    years.add(curYear); // 올해는 항상 포함
    clients.forEach((c) => {
      splitNote(c.note).reassessments.forEach((r) => {
        if (r.carePlan?.year) years.add(Number(r.carePlan.year));
      });
    });
    return [...years].sort((a, b) => b - a);
  }, [clients, curYear]);

  // 사례관리 계획 점검 탭: 사례관리 대상자만 + 담당자 필터
  const filteredClients = useMemo(
    () =>
      clients
        .filter(
          (c) =>
            !isTerminated(c) &&
            hasCareLevel(c) &&
            (workerFilter === "전체" || (c.worker_name ?? "") === workerFilter),
        )
        .sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [clients, workerFilter],
  );

  const allEntries = useMemo((): PlanEntry[] => {
    const entries: PlanEntry[] = [];
    filteredClients.forEach((c) => {
      const { reassessments } = splitNote(c.note);
      // 이 client + 연도의 links만 미리 필터링
      const clientYearLinks = planLinks.filter(
        (l) => l.client_id === c.id && l.plan_year === yearFilter,
      );
      reassessments.forEach((r) => {
        if (r.carePlan && Number(r.carePlan.year) === yearFilter && r.carePlan.rows.length > 0) {
          const yearLogs: Evidence[] = logs
            .filter(
              (l) =>
                l.client_id === c.id &&
                toKstDate(l.created_at).startsWith(yearFilter.toString()),
            )
            .map((l) => ({
              id: l.id,
              date: toKstDate(l.created_at),
              note: l.note ?? "",
              evidenceType: "log" as const,
            }));
          const yearProvs: Evidence[] = provisions
            .filter(
              (p) =>
                p.client_id === c.id &&
                p.provided_at.startsWith(yearFilter.toString()),
            )
            .map((p) => ({
              id: p.id,
              date: p.provided_at,
              note: [
                p.category,
                p.title,
                p.quantity ?? "",
                p.agency ? `(${p.agency})` : "",
                p.note ?? "",
              ].filter(Boolean).join(" "),
              evidenceType: "provision" as const,
            }));
          // care_plan_action_links 테이블 데이터로 action의 linked* 필드를 채운다(연결 정보의 유일한 저장소)
          const overriddenPlan = {
            ...r.carePlan,
            rows: r.carePlan.rows.map((row) => ({
              ...row,
              selfPlan: overrideActionLinks(row.selfPlan ?? [], clientYearLinks),
              workerPlan: overrideActionLinks(row.workerPlan ?? [], clientYearLinks),
            })),
          };
          entries.push({
            client: c,
            reassessedAt: r.reassessedAt ?? "",
            plan: overriddenPlan,
            yearLogs,
            yearProvs,
            allEvidence: [...yearLogs, ...yearProvs],
          });
        }
      });
    });
    return entries;
  }, [filteredClients, logs, provisions, yearFilter, planLinks]);

  // ── 달성률 미리 계산 ──────────────────────────────────────────────
  const ratedEntries = useMemo<RatedEntry[]>(
    () => allEntries.map((e) => ({ ...e, rate: planRate(e.plan, e.allEvidence) })),
    [allEntries],
  );

  const rateSummary = useMemo(() => ({
    total: ratedEntries.length,
    avg:   ratedEntries.length
      ? Math.round(ratedEntries.reduce((s, e) => s + e.rate, 0) / ratedEntries.length)
      : 0,
    great: ratedEntries.filter((e) => e.rate >= 80).length,
    good:  ratedEntries.filter((e) => e.rate >= 50 && e.rate < 80).length,
    mid:   ratedEntries.filter((e) => e.rate > 0 && e.rate < 50).length,
    zero:  ratedEntries.filter((e) => e.rate === 0).length,
  }), [ratedEntries]);

  const displayEntries = useMemo<RatedEntry[]>(() => {
    let entries = ratedEntries;
    if (rateFilter === "우수")      entries = entries.filter((e) => e.rate >= 80);
    else if (rateFilter === "보통") entries = entries.filter((e) => e.rate >= 50 && e.rate < 80);
    else if (rateFilter === "미달") entries = entries.filter((e) => e.rate > 0 && e.rate < 50);
    else if (rateFilter === "zero") entries = entries.filter((e) => e.rate === 0);
    if (rateSortDir === "desc") return [...entries].sort((a, b) => b.rate - a.rate);
    if (rateSortDir === "asc")  return [...entries].sort((a, b) => a.rate - b.rate);
    return entries;
  }, [ratedEntries, rateFilter, rateSortDir]);

  const groupedEntries = useMemo(() => {
    if (!groupByWorker) return null;
    const map = new Map<string, RatedEntry[]>();
    displayEntries.forEach((e) => {
      const w = e.client.worker_name ?? "미배정";
      if (!map.has(w)) map.set(w, []);
      map.get(w)!.push(e);
    });
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, "ko"));
  }, [displayEntries, groupByWorker]);

  const selected = clients.find((c) => c.id === selectedId) ?? null;
  useClientViewLog(selected, "서비스계획");
  const selectedEntry = selected
    ? allEntries.find((e) => e.client.id === selectedId)
    : null;

  // 수동 설정 저장
  async function saveManual() {
    if (!manualEdit) return;
    setSaving(true);
    try {
      const client = clients.find((c) => c.id === manualEdit.clientId);
      if (!client) { toast.error("대상자 정보를 찾을 수 없습니다."); return; }
      const parsed = splitNote(client.note);
      const rIdx = findReassessmentIdx(parsed.reassessments, manualEdit.reassessedAt, manualEdit.planYear);
      if (rIdx < 0) { toast.error("재사정 기록을 찾을 수 없습니다."); return; }
      const r = parsed.reassessments[rIdx];
      if (!r.carePlan) { toast.error("계획서 데이터가 없습니다."); return; }
      const rowIdx = r.carePlan.rows.findIndex((row) => row.id === manualEdit.rowId);
      if (rowIdx < 0) { toast.error("욕구영역 항목을 찾을 수 없습니다."); return; }
      const actions =
        manualEdit.role === "self"
          ? r.carePlan.rows[rowIdx].selfPlan
          : r.carePlan.rows[rowIdx].workerPlan;
      if (!actions) { toast.error("행동계획 배열이 없습니다."); return; }
      const aIdx = actions.findIndex((a) => a.id === manualEdit.action.id);
      if (aIdx < 0) { toast.error("행동계획 항목을 찾을 수 없습니다."); return; }
      actions[aIdx] = {
        ...actions[aIdx],
        manualRate: manualRate,
        manualNote: manualNote.trim() || undefined,
      };
      const newNote = joinNote(parsed.note, parsed.reassessments, parsed.goalAnalysis, parsed.closeReason, parsed.sideDishAssessments, parsed.mealOpinion, parsed.familyMembers);
      const { error } = await supabase
        .from("clients")
        .update({ note: newNote })
        .eq("id", client.id);
      if (error) throw error;
      toast.success("달성률이 수정되었습니다.");
      onChanged();
      const capturedNote = manualNote.trim();
      const capturedME = { ...manualEdit };
      const capturedAction = { ...actions[aIdx] };
      const capturedOrgId = client.org_id;
      setManualEdit(null);
      if (capturedNote) {
        setProvFormTarget({
          clientId: client.id,
          orgId: capturedOrgId,
          action: capturedAction,
          rowId: capturedME.rowId,
          role: capturedME.role,
          reassessedAt: capturedME.reassessedAt,
        });
        // 계획 항목 연동 기본 체크: 현재 행동계획 항목을 pre-select
        setProvSelectedIds(new Set([capturedAction.id]));
        setProvFields({
          category: PROVISION_CATEGORIES[0],
          title: capturedAction.text,
          quantity: capturedAction.targetCount
            ? `${capturedAction.targetCount}${capturedAction.unit ?? ""}`
            : "",
          agency: "",
          note: capturedNote,
          provided_at: new Date().toLocaleDateString("en-CA"),
        });
      }
    } catch (e) {
      toast.error("저장 실패: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // 수동 설정 초기화 (자동 계산으로 복원)
  async function clearManual() {
    if (!manualEdit) return;
    setSaving(true);
    try {
      const client = clients.find((c) => c.id === manualEdit.clientId);
      if (!client) { toast.error("대상자 정보를 찾을 수 없습니다."); return; }
      const parsed = splitNote(client.note);
      const rIdx = findReassessmentIdx(parsed.reassessments, manualEdit.reassessedAt, manualEdit.planYear);
      if (rIdx < 0) { toast.error("재사정 기록을 찾을 수 없습니다."); return; }
      const r = parsed.reassessments[rIdx];
      if (!r.carePlan) { toast.error("계획서 데이터가 없습니다."); return; }
      const rowIdx = r.carePlan.rows.findIndex((row) => row.id === manualEdit.rowId);
      if (rowIdx < 0) { toast.error("욕구영역 항목을 찾을 수 없습니다."); return; }
      const actions =
        manualEdit.role === "self"
          ? r.carePlan.rows[rowIdx].selfPlan
          : r.carePlan.rows[rowIdx].workerPlan;
      if (!actions) { toast.error("행동계획 배열이 없습니다."); return; }
      const aIdx = actions.findIndex((a) => a.id === manualEdit.action.id);
      if (aIdx < 0) { toast.error("행동계획 항목을 찾을 수 없습니다."); return; }
      const { manualRate: _mr, manualNote: _mn, ...rest } = actions[aIdx];
      actions[aIdx] = rest;
      const newNote = joinNote(parsed.note, parsed.reassessments, parsed.goalAnalysis, parsed.closeReason, parsed.sideDishAssessments, parsed.mealOpinion, parsed.familyMembers);
      const { data: updated, error: updateErr } = await supabase
        .from("clients")
        .update({ note: newNote })
        .eq("id", client.id)
        .eq("updated_at", client.updated_at)
        .select("id");
      if (updateErr) throw updateErr;
      if (!updated || updated.length === 0) {
        toast.error("다른 담당자가 방금 수정했습니다. 새로고침 후 다시 시도해주세요.");
        return;
      }
      toast.success("자동 계산으로 복원되었습니다.");
      onChanged();
      setManualEdit(null);
    } catch (e) {
      toast.error("저장 실패: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // ── ActionItem 에 전달할 stable 콜백 (useCallback으로 안정화) ──
  // React.useCallback: 의존성 배열이 바뀌지 않는 한 함수 참조 유지
  // → 모듈 레벨로 추출된 ActionItem이 불필요하게 remount되지 않음
  const stableUnlink = useCallback(
    async (clientId: string, actionId: string, kind: "log" | "prov", linkedId: string) => {
      const ok = await deleteCarePlanActionLinks(supabase, { clientId, kind, linkedId, actionIds: [actionId] });
      if (!ok) throw new Error("연동 해제 실패");
      onChanged();
    },
    [onChanged],
  );

  const stableOpenLog = useCallback(
    (id: string, note: string) => {
      setLogDetailId(id);
      setLogEditText(note);
      setLogEditMode(false);
    },
    [],
  );

  const stableOpenProv = useCallback(
    (prov: Provision) => {
      setProvDetailId(prov.id);
      setProvEditFields({
        provided_at: prov.provided_at,
        category: prov.category,
        title: prov.title,
        quantity: prov.quantity ?? "",
        agency: prov.agency ?? "",
        note: prov.note ?? "",
      });
      setProvEditMode(false);
    },
    [],
  );

  // setManualEdit · setManualRate · setManualNote는 모두 React stable dispatcher → deps 불필요
  const stableOpenManualEdit = useCallback(
    (entry: PlanEntry, rowId: string, action: CarePlanAction, role: "self" | "worker") => {
      const currentEvidence = computeActionResult(action, entry.allEvidence).evidence;
      setManualEdit({
        clientId: entry.client.id,
        reassessedAt: entry.reassessedAt,
        planYear: entry.plan.year,
        rowId,
        action,
        role,
        currentEvidence,
      });
      setManualRate(action.manualRate ?? computeActionResult(action, entry.allEvidence).rate);
      setManualNote(action.manualNote ?? "");
    },
    [], // React state dispatchers are stable — no deps needed
  );

  const stableOpenActionEdit = useCallback(
    (entry: PlanEntry, rowId: string, action: CarePlanAction, role: "self" | "worker") => {
      setActionEdit({ clientId: entry.client.id, reassessedAt: entry.reassessedAt, planYear: entry.plan.year, rowId, action, role });
      setActionEditText(action.text);
      setActionEditTarget(action.targetCount != null ? String(action.targetCount) : "");
      setActionEditUnit(action.unit ?? "");
    },
    [],
  );

  const stableOpenAddAction = useCallback(
    (entry: PlanEntry, rowId: string, role: "self" | "worker") => {
      setAddAction({ clientId: entry.client.id, reassessedAt: entry.reassessedAt, planYear: entry.plan.year, rowId, role });
      setAddActionText("");
      setAddActionCount("");
      setAddActionUnit("회");
    },
    [],
  );

  const stableDeleteAction = useCallback(
    async (entry: PlanEntry, rowId: string, action: CarePlanAction, role: "self" | "worker") => {
      try {
        const client = clients.find((c) => c.id === entry.client.id);
        if (!client) { toast.error("대상자 정보를 찾을 수 없습니다."); return; }
        const parsed = splitNote(client.note);
        const rIdx = findReassessmentIdx(parsed.reassessments, entry.reassessedAt, entry.plan.year);
        if (rIdx < 0) { toast.error("재사정 기록을 찾을 수 없습니다."); return; }
        const r = parsed.reassessments[rIdx];
        if (!r.carePlan) { toast.error("계획서 데이터가 없습니다."); return; }
        const rowIdx = r.carePlan.rows.findIndex((row) => row.id === rowId);
        if (rowIdx < 0) { toast.error("욕구영역 항목을 찾을 수 없습니다."); return; }
        const arr = role === "self"
          ? r.carePlan.rows[rowIdx].selfPlan
          : r.carePlan.rows[rowIdx].workerPlan;
        if (!arr) { toast.error("행동계획 배열이 없습니다."); return; }
        const aIdx = arr.findIndex((a) => a.id === action.id);
        if (aIdx < 0) { toast.error("행동계획 항목을 찾을 수 없습니다."); return; }
        arr.splice(aIdx, 1);
        const newNote = joinNote(parsed.note, parsed.reassessments, parsed.goalAnalysis, parsed.closeReason, parsed.sideDishAssessments, parsed.mealOpinion, parsed.familyMembers);
        const { error } = await supabase.from("clients").update({ note: newNote }).eq("id", client.id);
        if (error) { toast.error("삭제 실패: " + error.message); return; }
        await deleteLinksForAction(supabase, { clientId: client.id, actionId: action.id });
        toast.success("행동계획이 삭제되었습니다.");
        onChanged();
      } catch (e) {
        toast.error("삭제 실패: " + (e as Error).message);
      }
    },
    [clients, onChanged],
  );

  const stableMoveAction = useCallback(
    async (entry: PlanEntry, rowId: string, action: CarePlanAction, role: "self" | "worker", dir: "up" | "down") => {
      try {
        const client = clients.find((c) => c.id === entry.client.id);
        if (!client) { toast.error("대상자 정보를 찾을 수 없습니다."); return; }
        const parsed = splitNote(client.note);
        const rIdx = findReassessmentIdx(parsed.reassessments, entry.reassessedAt, entry.plan.year);
        if (rIdx < 0) { toast.error("재사정 기록을 찾을 수 없습니다."); return; }
        const r = parsed.reassessments[rIdx];
        if (!r.carePlan) { toast.error("계획서 데이터가 없습니다."); return; }
        const rowIdx = r.carePlan.rows.findIndex((row) => row.id === rowId);
        if (rowIdx < 0) { toast.error("욕구영역 항목을 찾을 수 없습니다."); return; }
        const arr = role === "self"
          ? r.carePlan.rows[rowIdx].selfPlan
          : r.carePlan.rows[rowIdx].workerPlan;
        if (!arr) { toast.error("행동계획 배열이 없습니다."); return; }
        const aIdx = arr.findIndex((a) => a.id === action.id);
        if (aIdx < 0) { toast.error("행동계획 항목을 찾을 수 없습니다."); return; }
        const swapIdx = dir === "up" ? aIdx - 1 : aIdx + 1;
        if (swapIdx < 0 || swapIdx >= arr.length) return;
        [arr[aIdx], arr[swapIdx]] = [arr[swapIdx], arr[aIdx]];
        const newNote = joinNote(parsed.note, parsed.reassessments, parsed.goalAnalysis, parsed.closeReason, parsed.sideDishAssessments, parsed.mealOpinion, parsed.familyMembers);
        const { error } = await supabase.from("clients").update({ note: newNote }).eq("id", client.id);
        if (error) { toast.error("순서 변경 실패: " + error.message); return; }
        toast.success("순서가 변경되었습니다.");
        onChanged();
      } catch (e) {
        toast.error("순서 변경 실패: " + (e as Error).message);
      }
    },
    [clients, onChanged],
  );

  const stableOpenRowEdit = useCallback(
    (entry: PlanEntry, row: CarePlanRow) => {
      setRowEdit({
        clientId: entry.client.id,
        reassessedAt: entry.reassessedAt,
        planYear: entry.plan.year,
        rowId: row.id,
      });
      setRowEditPriority(String(row.priority));
      setRowEditNeed(row.need);
    },
    [],
  );

  async function saveEditRow() {
    if (!rowEdit) return;
    const newPriority = Number(rowEditPriority);
    if (isNaN(newPriority) || newPriority < 1) { toast.error("올바른 우선순위를 입력해주세요."); return; }
    if (!rowEditNeed.trim()) { toast.error("욕구영역 내용을 입력해주세요."); return; }
    setRowEditBusy(true);
    try {
      const client = clients.find((c) => c.id === rowEdit.clientId);
      if (!client) { toast.error("대상자 정보를 찾을 수 없습니다."); return; }
      const parsed = splitNote(client.note);
      const rIdx = findReassessmentIdx(parsed.reassessments, rowEdit.reassessedAt, rowEdit.planYear);
      if (rIdx < 0) { toast.error("재사정 기록을 찾을 수 없습니다."); return; }
      const r = parsed.reassessments[rIdx];
      if (!r.carePlan) { toast.error("계획서 데이터가 없습니다."); return; }
      const rowIdx = r.carePlan.rows.findIndex((row) => row.id === rowEdit.rowId);
      if (rowIdx < 0) { toast.error("욕구영역 항목을 찾을 수 없습니다."); return; }
      r.carePlan.rows[rowIdx] = { ...r.carePlan.rows[rowIdx], priority: newPriority, need: rowEditNeed.trim() };
      const newNote = joinNote(parsed.note, parsed.reassessments, parsed.goalAnalysis, parsed.closeReason, parsed.sideDishAssessments, parsed.mealOpinion, parsed.familyMembers);
      const { error } = await supabase.from("clients").update({ note: newNote }).eq("id", client.id);
      if (error) throw error;
      toast.success("수정되었습니다.");
      onChanged();
      setRowEdit(null);
    } catch (e) {
      toast.error("저장 실패: " + (e as Error).message);
    } finally {
      setRowEditBusy(false);
    }
  }

  async function deleteRow() {
    if (!rowEdit) return;
    setRowEditBusy(true);
    try {
      const client = clients.find((c) => c.id === rowEdit.clientId);
      if (!client) { toast.error("대상자 정보를 찾을 수 없습니다."); return; }
      const parsed = splitNote(client.note);
      const rIdx = findReassessmentIdx(parsed.reassessments, rowEdit.reassessedAt, rowEdit.planYear);
      if (rIdx < 0) { toast.error("재사정 기록을 찾을 수 없습니다."); return; }
      const r = parsed.reassessments[rIdx];
      if (!r.carePlan) { toast.error("계획서 데이터가 없습니다."); return; }
      r.carePlan.rows = r.carePlan.rows.filter((row) => row.id !== rowEdit.rowId);
      const newNote = joinNote(parsed.note, parsed.reassessments, parsed.goalAnalysis, parsed.closeReason, parsed.sideDishAssessments, parsed.mealOpinion, parsed.familyMembers);
      const { error } = await supabase.from("clients").update({ note: newNote }).eq("id", client.id);
      if (error) throw error;
      toast.success("욕구영역이 삭제되었습니다.");
      onChanged();
      setRowEdit(null);
      setRowDeleteConfirm(false);
    } catch (e) {
      toast.error("삭제 실패: " + (e as Error).message);
    } finally {
      setRowEditBusy(false);
    }
  }

  async function saveActionEdit() {
    if (!actionEdit) return;
    if (!actionEditText.trim()) { toast.error("행동계획 내용을 입력해주세요."); return; }
    setActionEditBusy(true);
    try {
      const client = clients.find((c) => c.id === actionEdit.clientId);
      if (!client) { toast.error("대상자 정보를 찾을 수 없습니다."); return; }
      const parsed = splitNote(client.note);
      const rIdx = findReassessmentIdx(parsed.reassessments, actionEdit.reassessedAt, actionEdit.planYear);
      if (rIdx < 0) { toast.error("재사정 기록을 찾을 수 없습니다."); return; }
      const r = parsed.reassessments[rIdx];
      if (!r.carePlan) { toast.error("계획서 데이터가 없습니다."); return; }
      const rowIdx = r.carePlan.rows.findIndex((row) => row.id === actionEdit.rowId);
      if (rowIdx < 0) { toast.error("욕구영역 항목을 찾을 수 없습니다."); return; }
      const actions = actionEdit.role === "self"
        ? r.carePlan.rows[rowIdx].selfPlan
        : r.carePlan.rows[rowIdx].workerPlan;
      if (!actions) { toast.error("행동계획 배열이 없습니다."); return; }
      const aIdx = actions.findIndex((a) => a.id === actionEdit.action.id);
      if (aIdx < 0) { toast.error("행동계획 항목을 찾을 수 없습니다."); return; }
      const parsedTarget = actionEditTarget.trim() ? Number(actionEditTarget) : undefined;
      actions[aIdx] = {
        ...actions[aIdx],
        text: actionEditText.trim(),
        targetCount: !isNaN(parsedTarget ?? NaN) && parsedTarget != null ? parsedTarget : undefined,
        unit: actionEditUnit.trim() || undefined,
      };
      const newNote = joinNote(parsed.note, parsed.reassessments, parsed.goalAnalysis, parsed.closeReason, parsed.sideDishAssessments, parsed.mealOpinion, parsed.familyMembers);
      const { error } = await supabase.from("clients").update({ note: newNote }).eq("id", client.id);
      if (error) throw error;
      toast.success("행동계획이 수정되었습니다.");
      onChanged();
      setActionEdit(null);
    } catch (e) {
      toast.error("저장 실패: " + (e as Error).message);
    } finally {
      setActionEditBusy(false);
    }
  }

  async function saveAddAction() {
    if (!addAction) return;
    if (!addActionText.trim()) { toast.error("행동계획 내용을 입력해주세요."); return; }
    setAddActionBusy(true);
    try {
      const client = clients.find((c) => c.id === addAction.clientId);
      if (!client) { toast.error("대상자 정보를 찾을 수 없습니다."); return; }
      const parsed = splitNote(client.note);
      const rIdx = findReassessmentIdx(parsed.reassessments, addAction.reassessedAt, addAction.planYear);
      if (rIdx < 0) { toast.error("재사정 기록을 찾을 수 없습니다."); return; }
      const r = parsed.reassessments[rIdx];
      if (!r.carePlan) { toast.error("계획서 데이터가 없습니다."); return; }
      const rowIdx = r.carePlan.rows.findIndex((row) => row.id === addAction.rowId);
      if (rowIdx < 0) { toast.error("욕구영역 항목을 찾을 수 없습니다."); return; }
      const parsedCount = addActionCount.trim() ? Number(addActionCount) : undefined;
      const newAction: CarePlanAction = {
        id: crypto.randomUUID(),
        text: addActionText.trim(),
        targetCount: !isNaN(parsedCount ?? NaN) && parsedCount != null ? parsedCount : undefined,
        unit: addActionUnit.trim() || undefined,
      };
      if (addAction.role === "self") {
        r.carePlan.rows[rowIdx].selfPlan = [...(r.carePlan.rows[rowIdx].selfPlan ?? []), newAction];
      } else {
        r.carePlan.rows[rowIdx].workerPlan = [...(r.carePlan.rows[rowIdx].workerPlan ?? []), newAction];
      }
      const newNote = joinNote(parsed.note, parsed.reassessments, parsed.goalAnalysis, parsed.closeReason, parsed.sideDishAssessments, parsed.mealOpinion, parsed.familyMembers);
      const { error } = await supabase.from("clients").update({ note: newNote }).eq("id", client.id);
      if (error) throw error;
      toast.success("행동계획이 추가되었습니다.");
      onChanged();
      setAddAction(null);
    } catch (e) {
      toast.error("저장 실패: " + (e as Error).message);
    } finally {
      setAddActionBusy(false);
    }
  }

  const stableOpenProvForm = useCallback(
    (entry: PlanEntry, rowId: string, action: CarePlanAction, role: "self" | "worker") => {
      setProvFormTarget({
        clientId: entry.client.id,
        orgId: entry.client.org_id,
        action,
        rowId,
        role,
        reassessedAt: entry.reassessedAt,
      });
      // 버튼을 누른 항목을 기본 선택
      setProvSelectedIds(new Set([action.id]));
      setProvFields({
        category: PROVISION_CATEGORIES[0],
        title: action.text,
        quantity: action.targetCount
          ? `${action.targetCount}${action.unit ?? ""}`
          : "",
        agency: "",
        note: "",
        provided_at: new Date().toLocaleDateString("en-CA"),
      });
    },
    [],
  );

  // 제공이력 DB 저장 + 선택한 계획 항목에 linkedProvIds 연결
  async function saveProvFromManual() {
    if (!provFormTarget) return;
    if (!provFields.title.trim()) { toast.error("항목명을 입력해주세요."); return; }
    setProvFormBusy(true);
    try {
      // 1. provisions 테이블에 삽입
      const { data: inserted, error: insertErr } = await supabase
        .from("provisions")
        .insert({
          client_id: provFormTarget.clientId,
          org_id: provFormTarget.orgId,
          category: provFields.category,
          title: provFields.title.trim(),
          quantity: provFields.quantity || null,
          agency: provFields.agency || null,
          note: provFields.note || null,
          provided_at: provFields.provided_at,
        })
        .select("id")
        .single();
      if (insertErr) throw insertErr;
      const newProvId = (inserted as { id: string }).id;

      // 2. 선택된 계획 항목 전체에 연결 — care_plan_action_links 표에만 저장한다
      let linksOk = true;
      if (provSelectedIds.size > 0) {
        const targetClient = clients.find((c) => c.id === provFormTarget.clientId);
        if (targetClient) {
          linksOk = await insertCarePlanActionLinks(supabase, { clientId: targetClient.id, orgId: targetClient.org_id, linkedId: newProvId, kind: "prov", actionIds: provSelectedIds, yearByActionId: yearMapOf(getActiveCarePlanActions(targetClient)) });
        }
      }

      if (linksOk) toast.success("제공이력이 추가되었습니다.");
      else toast.error("제공이력은 추가됐지만 계획 항목 연동은 저장하지 못했어요. 제공이력 수정에서 연동을 다시 선택해 주세요.");
      onChanged();
      setProvFormTarget(null);
      setProvSelectedIds(new Set());
    } catch (e) {
      toast.error("저장 실패: " + (e as Error).message);
    } finally {
      setProvFormBusy(false);
    }
  }

  const actionItemShared = useMemo<ActionItemShared>(
    () => ({
      provisions,
      onUnlink: stableUnlink,
      onOpenLog: stableOpenLog,
      onOpenProv: stableOpenProv,
      onManualEdit: stableOpenManualEdit,
      onEditAction: stableOpenActionEdit,
      onAddProvFromManual: stableOpenProvForm,
      onDeleteAction: stableDeleteAction,
      onMoveAction: stableMoveAction,
      onAddAction: stableOpenAddAction,
      onEditRow: stableOpenRowEdit,
      canWrite,
    }),
    [provisions, stableUnlink, stableOpenLog, stableOpenProv, stableOpenManualEdit, stableOpenActionEdit, stableOpenProvForm, stableDeleteAction, stableMoveAction, stableOpenAddAction, stableOpenRowEdit, canWrite],
  );

  // ── 선택된 대상자 달성률 (planRate는 순수함수지만 4회 중복 호출 방지) ─
  const selectedPlanRate = useMemo(
    () =>
      selectedEntry
        ? planRate(selectedEntry.plan, selectedEntry.allEvidence)
        : 0,
    [selectedEntry],
  );

  // ── 렌더 ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      {/* 필터: 연도 + 담당자 */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={String(yearFilter)}
          onValueChange={(v) => setYearFilter(Number(v))}
        >
          <SelectTrigger className="w-28 h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {yearOptions.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}년
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={workerFilter} onValueChange={setWorkerFilter}>
          <SelectTrigger className="w-32 h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="전체">담당자 전체</SelectItem>
            {workers.map((w) => (
              <SelectItem key={w} value={w}>{w}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 전체 현황 요약 — 클릭 가능한 필터 카드 + 분포 차트 */}
      <Card>
        <CardContent className="pt-4 pb-3 space-y-3">
          {/* 달성률 구간 카드 (클릭 = 필터) */}
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            {(["전체", "우수", "보통", "미달", "zero"] as const).map((key) => {
              const CFG = {
                전체: { label: "전체",       count: rateSummary.total, ring: "ring-primary",       num: "text-foreground",                          bg: "bg-muted/30" },
                우수: { label: "우수 ≥80%",  count: rateSummary.great, ring: "ring-green-500",     num: "text-green-700 dark:text-green-400",       bg: "bg-green-50 dark:bg-green-950/20" },
                보통: { label: "보통 50~79%", count: rateSummary.good, ring: "ring-yellow-500",    num: "text-yellow-700 dark:text-yellow-400",     bg: "bg-yellow-50 dark:bg-yellow-950/20" },
                미달: { label: "미달 <50%",  count: rateSummary.mid,  ring: "ring-orange-500",    num: "text-orange-700 dark:text-orange-400",     bg: "bg-orange-50 dark:bg-orange-950/20" },
                zero: { label: "0%", sublabel: "실적 미등록", count: rateSummary.zero, ring: "ring-red-500", num: "text-red-700 dark:text-red-400", bg: "bg-red-50 dark:bg-red-950/20" },
              } as const;
              const c = CFG[key];
              const active = rateFilter === key;
              return (
                <button
                  key={key}
                  onClick={() => { setRateFilter(active ? "전체" : key); setSelectedId(null); }}
                  className={`rounded-lg border p-2.5 text-center transition-all ${
                    active
                      ? `ring-2 ${c.ring} ${c.bg} border-transparent`
                      : "border-border hover:border-primary/40 hover:bg-muted/20"
                  }`}
                >
                  <div className={`text-xl font-bold tabular-nums ${active ? c.num : ""}`}>{c.count}</div>
                  <div className="text-[11px] text-muted-foreground leading-tight">
                    {c.label}{"sublabel" in c && <span className="ml-1 text-muted-foreground/70">{c.sublabel}</span>}
                  </div>
                </button>
              );
            })}
          </div>

          {/* 하단 정보 + 동기화 버튼 */}
          <div className="flex flex-wrap items-center gap-4 text-sm border-t border-border pt-2">
            <div>
              <span className="text-muted-foreground">전체 평균</span>{" "}
              <span className={`font-bold ${rateColor(rateSummary.avg)}`}>{rateSummary.avg}%</span>
            </div>
            <div>
              <span className="text-muted-foreground">{yearFilter}년 상담</span>{" "}
              <span className="font-bold">
                {logs.filter((l) => toKstDate(l.created_at).startsWith(yearFilter.toString())).length}건
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">{yearFilter}년 제공이력</span>{" "}
              <span className="font-bold">
                {provisions.filter((p) => p.provided_at.startsWith(yearFilter.toString())).length}건
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-7 gap-1 text-xs"
              disabled={syncing}
              title="상담기록·제공이력을 최신 데이터로 동기화"
              onClick={async () => {
                setSyncing(true);
                await onChanged();
                setSyncing(false);
                toast.success("동기화 완료");
              }}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
              전체 동기화
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 대상자 선택 */}
      <div className="flex flex-wrap items-center gap-2">
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              className="justify-between min-w-[220px] max-w-full h-9"
            >
              <span className="flex items-center gap-2 truncate">
                <Search className="h-4 w-4 shrink-0 opacity-60" />
                {selected ? (
                  <>
                    <span className="truncate"><ClientName c={selected} /></span>
                    {hasCareLevel(selected) && (
                      <Badge
                        variant="outline"
                        className={`text-[10px] px-1.5 py-0 ${careLevelStyle[careLevelOf(selected)] ?? ""}`}
                      >
                        {careLevelOf(selected)}
                      </Badge>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">대상자 검색·선택</span>
                )}
              </span>
              <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[300px] p-0" align="start">
            <Command>
              <CommandInput placeholder="이름·연락처 검색" />
              <CommandList>
                <CommandEmpty>대상자가 없습니다.</CommandEmpty>
                <CommandGroup>
                  {filteredClients.map((c) => {
                    const hasplan = allEntries.some((e) => e.client.id === c.id);
                    return (
                      <CommandItem
                        key={c.id}
                        value={`${c.name} ${c.phone ?? ""}`}
                        onSelect={() => {
                          setSelectedId(c.id);
                          setPickerOpen(false);
                        }}
                      >
                        <span className="font-medium truncate"><ClientName c={c} /></span>
                        {programsOf(c).map((p) => (
                          <Badge
                            key={p}
                            variant="outline"
                            className={`ml-1 text-[10px] px-1.5 py-0 ${programStyle[p] ?? ""}`}
                          >
                            {p}
                          </Badge>
                        ))}
                        {hasplan ? (
                          <CheckCircle2 className="ml-auto h-3.5 w-3.5 text-green-500" />
                        ) : (
                          <CircleDashed className="ml-auto h-3.5 w-3.5 text-muted-foreground/40" />
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {selectedId && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 text-muted-foreground"
            onClick={() => setSelectedId(null)}
          >
            전체 보기
          </Button>
        )}
      </div>

      {/* 뷰 옵션 — 전체 목록일 때만 표시 */}
      {!selected && allEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {rateFilter !== "전체" && (
            <button
              onClick={() => setRateFilter("전체")}
              className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-2.5 py-0.5 text-xs text-primary hover:bg-primary/10 transition-colors"
            >
              <X className="h-3 w-3" />
              필터 해제
            </button>
          )}
          <Button
            size="sm"
            variant={groupByWorker ? "secondary" : "outline"}
            className="h-7 gap-1.5 text-xs ml-auto"
            onClick={() => setGroupByWorker((v) => !v)}
          >
            <Users className="h-3.5 w-3.5" />
            담당자별 묶기
          </Button>
        </div>
      )}

      {/* 선택 없음: 전체 요약 테이블 */}
      {!selected ? (
        <div className="space-y-2">
          {allEntries.length === 0 ? (
            <div className="h-[40dvh] rounded-lg border border-dashed flex flex-col items-center justify-center text-center text-muted-foreground gap-2">
              <ClipboardList className="h-8 w-8 opacity-40" />
              <p className="text-sm">
                {yearFilter}년 계획서가 없어요.
                <br />
                [재사정] 탭에서 파일 업로드 시 자동으로 추출됩니다.
              </p>
            </div>
          ) : displayEntries.length === 0 ? (
            <div className="py-10 rounded-lg border border-dashed text-center text-muted-foreground text-sm space-y-1">
              <p>해당 조건의 대상자가 없습니다.</p>
              <button
                onClick={() => setRateFilter("전체")}
                className="text-xs text-primary hover:underline"
              >
                필터 해제
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-muted-foreground text-xs">
                    <th className="text-left px-3 py-2 font-medium">대상자</th>
                    <th className="hidden sm:table-cell text-left px-3 py-2 font-medium">담당자</th>
                    <th className="hidden md:table-cell text-left px-3 py-2 font-medium">계획 항목</th>
                    <th
                      className="text-left px-3 py-2 font-medium min-w-[120px] cursor-pointer select-none hover:text-foreground group"
                      onClick={() =>
                        setRateSortDir((d) => (d === null ? "desc" : d === "desc" ? "asc" : null))
                      }
                    >
                      <span className="flex items-center gap-1">
                        달성률
                        {rateSortDir === "desc" ? (
                          <ArrowDown className="h-3 w-3 text-primary" />
                        ) : rateSortDir === "asc" ? (
                          <ArrowUp className="h-3 w-3 text-primary" />
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40 group-hover:opacity-100" />
                        )}
                      </span>
                    </th>
                    <th className="px-3 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {(groupedEntries
                    ? groupedEntries.flatMap(([worker, wEntries]) => [
                        <tr key={`grp-${worker}`} className="bg-muted/20 dark:bg-muted/10">
                          <td colSpan={5} className="px-3 py-1.5">
                            <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                              <Users className="h-3.5 w-3.5" />
                              {worker}
                              <span className="font-normal">({wEntries.length}명)</span>
                            </span>
                          </td>
                        </tr>,
                        ...wEntries.map((entry) => (
                          <tr
                            key={`${entry.client.id}-${entry.reassessedAt}`}
                            className={`border-b last:border-0 hover:bg-muted/20 cursor-pointer transition-colors ${
                              entry.rate === 0 ? "border-l-4 border-l-red-400" : ""
                            }`}
                            onClick={() => { setSelectedId(entry.client.id); setSelfSectionOpen(true); setWorkerSectionOpen(true); }}
                          >
                            <td className="px-3 py-2 font-medium">
                              <ClientName c={entry.client} />
                              {hasCareLevel(entry.client) && (
                                <Badge variant="outline" className={`ml-1 text-[10px] px-1.5 py-0 ${careLevelStyle[careLevelOf(entry.client)] ?? ""}`}>
                                  {careLevelOf(entry.client)}
                                </Badge>
                              )}
                            </td>
                            <td className="hidden sm:table-cell px-3 py-2 text-muted-foreground">
                              {entry.client.worker_name ?? "미배정"}
                            </td>
                            <td className="hidden md:table-cell px-3 py-2">
                              <div className="flex flex-wrap gap-1 mb-0.5">
                                {entry.plan.rows.slice(0, 2).map((r) => (
                                  <span key={r.id} className="inline-block max-w-[90px] truncate rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground" title={r.need}>{r.need}</span>
                                ))}
                                {entry.plan.rows.length > 2 && (
                                  <span className="text-[10px] text-muted-foreground self-center">+{entry.plan.rows.length - 2}</span>
                                )}
                              </div>
                              <div className="flex gap-1">
                                <span className="rounded bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 text-[9px] px-1 py-0.5">
                                  당사자 {entry.plan.rows.reduce((s, r) => s + r.selfPlan.length, 0)}
                                </span>
                                <span className="rounded bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 text-[9px] px-1 py-0.5">
                                  담당자 {entry.plan.rows.reduce((s, r) => s + r.workerPlan.length, 0)}
                                </span>
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <Progress value={entry.rate} className={`h-2 w-24 ${RATE_BG[rateKey(entry.rate)]}`} />
                                <span className={`font-semibold ${rateColor(entry.rate)}`}>{entry.rate}%</span>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">자세히 →</td>
                          </tr>
                        )),
                      ])
                    : displayEntries.map((entry) => (
                        <tr
                          key={`${entry.client.id}-${entry.reassessedAt}`}
                          className={`border-b last:border-0 hover:bg-muted/20 cursor-pointer transition-colors ${
                            entry.rate === 0 ? "border-l-4 border-l-red-400" : ""
                          }`}
                          onClick={() => { setSelectedId(entry.client.id); setSelfSectionOpen(true); setWorkerSectionOpen(true); }}
                        >
                          <td className="px-3 py-2 font-medium">
                            <ClientName c={entry.client} />
                            {hasCareLevel(entry.client) && (
                              <Badge variant="outline" className={`ml-1 text-[10px] px-1.5 py-0 ${careLevelStyle[careLevelOf(entry.client)] ?? ""}`}>
                                {careLevelOf(entry.client)}
                              </Badge>
                            )}
                          </td>
                          <td className="hidden sm:table-cell px-3 py-2 text-muted-foreground">
                            {entry.client.worker_name ?? "미배정"}
                          </td>
                          <td className="hidden md:table-cell px-3 py-2">
                            <div className="flex flex-wrap gap-1 mb-0.5">
                              {entry.plan.rows.slice(0, 2).map((r) => (
                                <span key={r.id} className="inline-block max-w-[90px] truncate rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground" title={r.need}>{r.need}</span>
                              ))}
                              {entry.plan.rows.length > 2 && (
                                <span className="text-[10px] text-muted-foreground self-center">+{entry.plan.rows.length - 2}</span>
                              )}
                            </div>
                            <div className="flex gap-1">
                              <span className="rounded bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 text-[9px] px-1 py-0.5">
                                당사자 {entry.plan.rows.reduce((s, r) => s + r.selfPlan.length, 0)}
                              </span>
                              <span className="rounded bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 text-[9px] px-1 py-0.5">
                                담당자 {entry.plan.rows.reduce((s, r) => s + r.workerPlan.length, 0)}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <Progress value={entry.rate} className={`h-2 w-24 ${RATE_BG[rateKey(entry.rate)]}`} />
                              <span className={`font-semibold ${rateColor(entry.rate)}`}>{entry.rate}%</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">자세히 →</td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        /* 대상자 선택 시: 상세 계획 뷰 */
        <div className="space-y-3">
          {!selectedEntry ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
              <ClipboardList className="h-8 w-8 opacity-40 mx-auto mb-2" />
              <p className="text-sm">
                <ClientName c={selected} />님의 {yearFilter}년 계획서가 없어요.
              </p>
              <p className="text-xs mt-1">
                [재사정] 탭에서 해당 연도 기록지를 업로드하거나 [계획서 추출] 버튼을 눌러주세요.
              </p>
            </div>
          ) : (
            <>
              {/* 대상자 요약 헤더 */}
              <Card>
                <CardContent className="pt-4 pb-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <span className="font-semibold text-base"><ClientName c={selected} /></span>
                      <span className="text-sm text-muted-foreground ml-2">
                        담당 {selected.worker_name ?? "미배정"}
                      </span>
                      <span className="text-sm text-muted-foreground ml-2">
                        {yearFilter}년 계획
                      </span>
                    </div>
                    <div className="text-right">
                      <div className={`text-3xl font-bold ${rateColor(selectedPlanRate)}`}>
                        {selectedPlanRate}%
                      </div>
                      <div className="text-[11px] text-muted-foreground">전체 평균 달성률</div>
                    </div>
                  </div>
                  <Progress
                    value={selectedPlanRate}
                    className={`mt-2 h-2 ${RATE_BG[rateKey(selectedPlanRate)]}`}
                  />
                  <div className="flex items-center gap-3 flex-wrap mt-1">
                    <p className="text-[11px] text-muted-foreground flex-1">
                      {yearFilter}년 상담 {selectedEntry.yearLogs.length}건 · 제공이력 {selectedEntry.yearProvs.length}건 기준 ·
                      달성률은 키워드 자동 분석이며 수동 수정 가능합니다.
                      ℹ️ 버튼으로 근거 확인·수정.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 text-xs shrink-0"
                      disabled={syncing}
                      title="이 대상자 상담·제공이력 최신화"
                      onClick={async () => {
                        setSyncing(true);
                        await onChanged();
                        setSyncing(false);
                        toast.success("동기화 완료");
                      }}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
                      동기화
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* 계획 항목 목록 */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <ClipboardList className="h-4 w-4" />
                    사례관리 계획 항목{" "}
                    <span className="text-sm font-normal text-muted-foreground">
                      ({selectedEntry.plan.rows.length}개)
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* ── 당사자 행동계획 — 중점 대상자에게만 표시 ── */}
                  {careLevelOf(selectedEntry.client) === "중점" && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <button
                        className="flex items-center gap-1.5 py-1 text-left"
                        onClick={() => setSelfSectionOpen((v) => !v)}
                      >
                        <span className="text-xs font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
                          당사자 행동계획
                        </span>
                        {selfSectionOpen ? (
                          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </button>
                    </div>
                    {selfSectionOpen && (
                      <div className="space-y-2">
                        {selectedEntry.plan.rows
                          .slice()
                          .sort((a, b) => a.priority - b.priority)
                          .map((row) => {
                            const selfActions = row.selfPlan ?? [];
                            const rate = selfActions.length
                              ? Math.round(selfActions.reduce((s, a) => s + computeActionResult(a, selectedEntry.allEvidence).rate, 0) / selfActions.length)
                              : 0;
                            return (
                              <div key={row.id + "-self"} className="rounded-md border border-border overflow-hidden">
                                <div className="flex items-center gap-2 px-3 py-2 bg-muted/20">
                                  <Badge variant="outline" className="shrink-0 text-xs font-bold border-primary text-primary">
                                    우선{row.priority}
                                  </Badge>
                                  <span className="font-medium text-sm flex-1 truncate">{row.need}</span>
                                  <span className={`text-xs font-semibold shrink-0 ${rateColor(rate)}`}>{rate}%</span>
                                  {canWrite && (
                                    <>
                                      <Button
                                        size="sm" variant="outline"
                                        className="h-6 px-2 text-[11px] text-muted-foreground border-border hover:bg-muted gap-0.5 shrink-0"
                                        onClick={() => actionItemShared.onEditRow(selectedEntry, row)}
                                        title="욕구영역 수정"
                                      >
                                        <Pencil className="h-3 w-3" />수정
                                      </Button>
                                      <Button
                                        size="sm" variant="outline"
                                        className="h-6 px-2 text-[11px] text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800 hover:bg-blue-50 dark:hover:bg-blue-950/40 gap-0.5 shrink-0"
                                        onClick={() => actionItemShared.onAddAction(selectedEntry, row.id, "self")}
                                      >
                                        <Plus className="h-3 w-3" />추가
                                      </Button>
                                    </>
                                  )}
                                </div>
                                <div className="p-3 space-y-3">
                                  {selfActions.length > 0 ? selfActions.map((action, idx) => (
                                    <ActionItem
                                      key={action.id}
                                      action={action}
                                      entry={selectedEntry}
                                      rowId={row.id}
                                      role="self"
                                      index={idx}
                                      total={selfActions.length}
                                      shared={actionItemShared}
                                    />
                                  )) : (
                                    <p className="text-xs text-muted-foreground">등록된 당사자 행동계획이 없습니다.</p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </div>
                  )}

                  {/* ── 담당자 행동계획 ── */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <button
                        className="flex items-center gap-1.5 py-1 text-left"
                        onClick={() => setWorkerSectionOpen((v) => !v)}
                      >
                        <span className="text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
                          담당자 행동계획
                        </span>
                        {workerSectionOpen ? (
                          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </button>
                    </div>
                    {workerSectionOpen && (
                      <div className="space-y-2">
                        {selectedEntry.plan.rows
                          .slice()
                          .sort((a, b) => a.priority - b.priority)
                          .map((row) => {
                            const workerActions = row.workerPlan ?? [];
                            const rate = workerActions.length
                              ? Math.round(workerActions.reduce((s, a) => s + computeActionResult(a, selectedEntry.allEvidence).rate, 0) / workerActions.length)
                              : 0;
                            return (
                              <div key={row.id + "-worker"} className="rounded-md border border-border overflow-hidden">
                                <div className="flex items-center gap-2 px-3 py-2 bg-muted/20">
                                  <Badge variant="outline" className="shrink-0 text-xs font-bold border-primary text-primary">
                                    우선{row.priority}
                                  </Badge>
                                  <span className="font-medium text-sm flex-1 truncate">{row.need}</span>
                                  <span className={`text-xs font-semibold shrink-0 ${rateColor(rate)}`}>{rate}%</span>
                                  {canWrite && (
                                    <>
                                      <Button
                                        size="sm" variant="outline"
                                        className="h-6 px-2 text-[11px] text-muted-foreground border-border hover:bg-muted gap-0.5 shrink-0"
                                        onClick={() => actionItemShared.onEditRow(selectedEntry, row)}
                                        title="욕구영역 수정"
                                      >
                                        <Pencil className="h-3 w-3" />수정
                                      </Button>
                                      <Button
                                        size="sm" variant="outline"
                                        className="h-6 px-2 text-[11px] text-violet-600 dark:text-violet-400 border-violet-200 dark:border-violet-800 hover:bg-violet-50 dark:hover:bg-violet-950/40 gap-0.5 shrink-0"
                                        onClick={() => actionItemShared.onAddAction(selectedEntry, row.id, "worker")}
                                      >
                                        <Plus className="h-3 w-3" />추가
                                      </Button>
                                    </>
                                  )}
                                </div>
                                <div className="p-3 space-y-3">
                                  {workerActions.length > 0 ? workerActions.map((action, idx) => (
                                    <ActionItem
                                      key={action.id}
                                      action={action}
                                      entry={selectedEntry}
                                      rowId={row.id}
                                      role="worker"
                                      index={idx}
                                      total={workerActions.length}
                                      shared={actionItemShared}
                                    />
                                  )) : (
                                    <p className="text-xs text-muted-foreground">등록된 담당자 행동계획이 없습니다.</p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* 미배정 제공이력 — 어떤 행동계획에도 매칭되지 않은 제공이력 */}
              {(() => {
                const assignedProvIds = new Set(
                  selectedEntry.plan.rows.flatMap((row) =>
                    [...row.selfPlan, ...row.workerPlan].flatMap(
                      (a) => computeActionResult(a, selectedEntry.allEvidence).evidence
                        .filter((e) => e.evidenceType === "provision")
                        .map((e) => e.id),
                    ),
                  ),
                );
                const unlinkedProvs = selectedEntry.yearProvs.filter(
                  (p) => !assignedProvIds.has(p.id),
                );
                if (unlinkedProvs.length === 0) return null;
                return (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground select-none flex items-center gap-1 hover:text-foreground">
                      <Package className="h-3 w-3" />
                      미배정 제공이력 ({unlinkedProvs.length}건)
                      <span className="ml-1 opacity-60">— 계획에 연결되지 않은 항목</span>
                    </summary>
                    <div className="mt-1.5 flex flex-wrap gap-1.5 pl-1">
                      {unlinkedProvs.map((ev) => (
                        <button
                          key={ev.id}
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/30 px-2 py-0.5 text-[11px] text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors"
                          onClick={() => {
                            const prov = provisions.find((p) => p.id === ev.id);
                            if (!prov) return;
                            setProvDetailId(ev.id);
                            setProvEditFields({
                              provided_at: prov.provided_at, category: prov.category,
                              title: prov.title, quantity: prov.quantity ?? "",
                              agency: prov.agency ?? "", note: prov.note ?? "",
                            });
                            setProvEditMode(false);
                          }}
                          title={ev.note}
                        >
                          <Package className="h-2.5 w-2.5 shrink-0" />
                          <span className="font-medium">{ev.date}</span>
                          <span className="max-w-[160px] truncate">{ev.note}</span>
                        </button>
                      ))}
                    </div>
                  </details>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* 행동계획 수정 다이얼로그 */}
      <Dialog open={!!actionEdit} onOpenChange={(open) => !open && setActionEdit(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <Pencil className="h-4 w-4 text-primary" />
              행동계획 수정
            </DialogTitle>
            <DialogDescription>
              행동계획 내용과 목표 횟수를 수정합니다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <label className="text-sm font-medium">행동계획 내용 <span className="text-red-500">*</span></label>
              <textarea
                className="w-full text-sm rounded-md border border-input p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                rows={3}
                value={actionEditText}
                onChange={(e) => setActionEditText(e.target.value)}
                placeholder="예: 절기 태마 식료품 키트 지원"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">목표 횟수 <span className="text-muted-foreground font-normal">(선택)</span></label>
                <input
                  type="number"
                  min={1}
                  className="w-full text-sm rounded-md border border-input px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                  value={actionEditTarget}
                  onChange={(e) => setActionEditTarget(e.target.value)}
                  placeholder="예: 3"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">단위 <span className="text-muted-foreground font-normal">(선택)</span></label>
                <input
                  className="w-full text-sm rounded-md border border-input px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                  value={actionEditUnit}
                  onChange={(e) => setActionEditUnit(e.target.value)}
                  placeholder="예: 회"
                />
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setActionEdit(null)} disabled={actionEditBusy}>
              취소
            </Button>
            <Button onClick={saveActionEdit} disabled={actionEditBusy}>
              {actionEditBusy ? "저장 중…" : "저장"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 행동계획 추가 다이얼로그 */}
      <Dialog open={!!addAction} onOpenChange={(open) => !open && setAddAction(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <Plus className="h-4 w-4 text-primary" />
              행동계획 추가
            </DialogTitle>
            <DialogDescription>
              {addAction?.role === "self" ? "당사자" : "담당자"} 행동계획을 추가합니다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <label className="text-sm font-medium">행동계획 내용 <span className="text-red-500">*</span></label>
              <textarea
                className="w-full text-sm rounded-md border border-input p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                rows={3}
                value={addActionText}
                onChange={(e) => setAddActionText(e.target.value)}
                placeholder="예: 절기 테마 식료품 키트 지원"
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">목표 횟수 <span className="text-muted-foreground font-normal">(선택)</span></label>
                <input
                  type="number"
                  min={1}
                  className="w-full text-sm rounded-md border border-input px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                  value={addActionCount}
                  onChange={(e) => setAddActionCount(e.target.value)}
                  placeholder="예: 3"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">단위 <span className="text-muted-foreground font-normal">(선택)</span></label>
                <input
                  className="w-full text-sm rounded-md border border-input px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                  value={addActionUnit}
                  onChange={(e) => setAddActionUnit(e.target.value)}
                  placeholder="예: 회"
                />
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setAddAction(null)} disabled={addActionBusy}>
              취소
            </Button>
            <Button onClick={saveAddAction} disabled={addActionBusy}>
              {addActionBusy ? "추가 중…" : "추가"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 달성률 수동 수정 다이얼로그 */}
      <Dialog open={!!manualEdit} onOpenChange={(open) => !open && setManualEdit(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>달성률 수동 수정</DialogTitle>
          </DialogHeader>
          {manualEdit && (
            <div className="space-y-4 py-2">
              <div className="rounded-md bg-muted/50 p-3">
                <p className="text-sm font-medium">{manualEdit.action.text}</p>
                {manualEdit.action.targetCount && (
                  <p className="text-xs text-muted-foreground mt-1">
                    목표: {manualEdit.action.targetCount}{manualEdit.action.unit ?? "회"}
                  </p>
                )}
              </div>

              {/* 자동 계산 근거 */}
              {manualEdit.currentEvidence.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    자동 분석 근거 ({manualEdit.currentEvidence.length}건)
                  </p>
                  <div className="max-h-32 overflow-y-auto space-y-1 border rounded p-2">
                    {manualEdit.currentEvidence.map((ev) => (
                      <p key={ev.id} className="text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground">{ev.date}</span> —{" "}
                        {ev.note.slice(0, 70)}{ev.note.length > 70 ? "…" : ""}
                      </p>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    ※ 위 기록에서 관련 키워드가 감지됐습니다. 잘못 분류됐다면 아래에서 직접 수정하세요.
                  </p>
                </div>
              )}

              {/* 달성률 슬라이더 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">달성률</label>
                  <span className={`text-lg font-bold ${rateColor(manualRate)}`}>
                    {manualRate}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={manualRate}
                  onChange={(e) => setManualRate(Number(e.target.value))}
                  className="w-full accent-primary"
                />
                <Progress value={manualRate} className={`h-2 ${RATE_BG[rateKey(manualRate)]}`} />
              </div>

              {/* 메모 */}
              <div className="space-y-1">
                <label className="text-sm font-medium">
                  수정 사유{" "}
                  <span className="text-muted-foreground font-normal">(선택)</span>
                </label>
                <textarea
                  className="w-full text-sm rounded-md border border-input p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                  rows={2}
                  value={manualNote}
                  onChange={(e) => setManualNote(e.target.value)}
                  placeholder="예: 쌀 지원으로 처리됨, 잡곡 키워드 미일치"
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            {manualEdit?.action.manualRate != null && (
              <Button variant="ghost" onClick={clearManual} disabled={saving}>
                자동 계산으로 복원
              </Button>
            )}
            <Button variant="outline" onClick={() => setManualEdit(null)}>
              취소
            </Button>
            <Button onClick={saveManual} disabled={saving}>
              저장
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 제공이력 추가 다이얼로그 */}
      {(() => {
        const provClient = provFormTarget ? clients.find((c) => c.id === provFormTarget.clientId) : null;
        const provPlanActions: ActiveAction[] = provClient
          ? applyLinksToActions(
              getActiveCarePlanActions(provClient),
              planLinks.filter((l) => l.client_id === provClient.id),
            )
          : [];
        return (
          <Dialog open={!!provFormTarget} onOpenChange={(open) => { if (!open) { setProvFormTarget(null); setProvSelectedIds(new Set()); } }}>
            <DialogContent className="sm:max-w-md max-h-[90dvh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-1.5">
                  <Package className="h-4 w-4 text-indigo-500" />
                  제공이력 추가
                </DialogTitle>
                <DialogDescription>
                  제공이력을 등록하고, 해당되는 계획 항목을 선택하세요.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-1">
                {/* 분류 */}
                <div className="space-y-1">
                  <label className="text-sm font-medium">분류</label>
                  <Select
                    value={provFields.category}
                    onValueChange={(v) => setProvFields((f) => ({ ...f, category: v as typeof PROVISION_CATEGORIES[number] }))}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVISION_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {/* 항목명 */}
                <div className="space-y-1">
                  <label className="text-sm font-medium">항목명 <span className="text-red-500">*</span></label>
                  <input
                    className="w-full text-sm rounded-md border border-input px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                    value={provFields.title}
                    onChange={(e) => setProvFields((f) => ({ ...f, title: e.target.value }))}
                    placeholder="예: 쌀 10kg"
                  />
                </div>
                {/* 수량 */}
                <div className="space-y-1">
                  <label className="text-sm font-medium">수량 <span className="text-muted-foreground font-normal">(선택)</span></label>
                  <input
                    className="w-full text-sm rounded-md border border-input px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                    value={provFields.quantity}
                    onChange={(e) => setProvFields((f) => ({ ...f, quantity: e.target.value }))}
                    placeholder="예: 1포, 2회"
                  />
                </div>
                {/* 제공기관 */}
                <div className="space-y-1">
                  <label className="text-sm font-medium">제공기관 <span className="text-muted-foreground font-normal">(선택)</span></label>
                  <input
                    className="w-full text-sm rounded-md border border-input px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                    value={provFields.agency}
                    onChange={(e) => setProvFields((f) => ({ ...f, agency: e.target.value }))}
                    placeholder="예: OO구청"
                  />
                </div>
                {/* 제공일 */}
                <div className="space-y-1">
                  <label className="text-sm font-medium">제공일</label>
                  <input
                    type="date"
                    className="w-full text-sm rounded-md border border-input px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                    value={provFields.provided_at}
                    onChange={(e) => setProvFields((f) => ({ ...f, provided_at: e.target.value }))}
                  />
                </div>
                {/* 메모 */}
                <div className="space-y-1">
                  <label className="text-sm font-medium">메모 <span className="text-muted-foreground font-normal">(선택)</span></label>
                  <textarea
                    className="w-full text-sm rounded-md border border-input p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                    rows={2}
                    value={provFields.note}
                    onChange={(e) => setProvFields((f) => ({ ...f, note: e.target.value }))}
                    placeholder="비고 내용 (선택)"
                  />
                </div>
                {/* 계획 항목 연동 */}
                {provPlanActions.length > 0 && (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium flex items-center gap-1.5">
                      <ClipboardList className="h-3.5 w-3.5 text-indigo-500" />
                      계획 항목 연동
                      <span className="text-muted-foreground font-normal text-xs">(해당되는 항목 선택)</span>
                    </label>
                    <div className="rounded-md border border-border divide-y divide-border max-h-44 overflow-y-auto">
                      {provPlanActions.some(({ role }) => role === "self") && <div className="px-3 py-0.5 bg-blue-50/60 dark:bg-blue-950/20 text-[10px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide sticky top-0">당사자</div>}
                      {provPlanActions.filter(({ role }) => role === "self").map(({ action, area }) => (
                        <label
                          key={action.id}
                          className={`flex items-start gap-2.5 px-3 py-2 cursor-pointer text-sm hover:bg-muted/40 transition-colors ${provSelectedIds.has(action.id) ? "bg-primary/5" : ""}`}
                        >
                          <Checkbox
                            checked={provSelectedIds.has(action.id)}
                            onCheckedChange={(checked) => {
                              setProvSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (checked) next.add(action.id); else next.delete(action.id);
                                return next;
                              });
                            }}
                            className="mt-0.5"
                          />
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">{area}</p>
                            <p className="truncate">{action.text}</p>
                            {action.targetCount && (
                              <p className="text-[11px] text-muted-foreground">목표 {action.targetCount}{action.unit ?? ""}</p>
                            )}
                          </div>
                        </label>
                      ))}
                      {provPlanActions.some(({ role }) => role === "worker") && <div className="px-3 py-0.5 bg-violet-50/60 dark:bg-violet-950/20 text-[10px] font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wide sticky top-0">담당자</div>}
                      {provPlanActions.filter(({ role }) => role === "worker").map(({ action, area }) => (
                        <label
                          key={action.id}
                          className={`flex items-start gap-2.5 px-3 py-2 cursor-pointer text-sm hover:bg-muted/40 transition-colors ${provSelectedIds.has(action.id) ? "bg-primary/5" : ""}`}
                        >
                          <Checkbox
                            checked={provSelectedIds.has(action.id)}
                            onCheckedChange={(checked) => {
                              setProvSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (checked) next.add(action.id); else next.delete(action.id);
                                return next;
                              });
                            }}
                            className="mt-0.5"
                          />
                          <div className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">{area}</p>
                            <p className="truncate">{action.text}</p>
                            {action.targetCount && (
                              <p className="text-[11px] text-muted-foreground">목표 {action.targetCount}{action.unit ?? ""}</p>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => { setProvFormTarget(null); setProvSelectedIds(new Set()); }} disabled={provFormBusy}>
                  취소
                </Button>
                <Button onClick={saveProvFromManual} disabled={provFormBusy}>
                  {provFormBusy ? "저장 중…" : "제공이력 저장"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        );
      })()}

      {/* 근거 상담기록 상세보기·수정 다이얼로그 */}
      {(() => {
        const detailLog = logDetailId ? logs.find((l) => l.id === logDetailId) : null;
        return (
          <Dialog
            open={!!logDetailId}
            onOpenChange={(open) => {
              if (!open) {
                setLogDetailId(null);
                setLogEditMode(false);
              }
            }}
          >
            <DialogContent className="max-w-xl max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-1.5">
                  <BookOpen className="h-4 w-4 text-primary" />
                  근거 상담기록 상세
                </DialogTitle>
                <DialogDescription>
                  {detailLog
                    ? `${new Date(detailLog.created_at).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" })} · ${detailLog.method ?? "-"} · ${detailLog.worker_name ?? "-"}`
                    : ""}
                </DialogDescription>
              </DialogHeader>

              {detailLog && (
                <div className="space-y-3 py-1">
                  {logEditMode ? (
                    <textarea
                      value={logEditText}
                      onChange={(e) => setLogEditText(e.target.value)}
                      rows={10}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-primary"
                      autoFocus
                    />
                  ) : (
                    <p className="text-sm whitespace-pre-wrap leading-relaxed rounded-md bg-muted/40 p-3">
                      {detailLog.note || <span className="text-muted-foreground italic">내용 없음</span>}
                    </p>
                  )}
                </div>
              )}

              <DialogFooter className="flex-wrap gap-2">
                {logEditMode ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setLogEditMode(false);
                        setLogEditText(detailLog?.note ?? "");
                      }}
                      disabled={logEditBusy}
                    >
                      취소
                    </Button>
                    <Button
                      disabled={logEditBusy}
                      onClick={async () => {
                        if (!logDetailId) return;
                        setLogEditBusy(true);
                        const { error } = await supabase
                          .from("activity_logs")
                          .update({ note: logEditText.trim() })
                          .eq("id", logDetailId);
                        setLogEditBusy(false);
                        if (error) {
                          toast.error(error.message);
                        } else {
                          toast.success("상담기록이 수정되었습니다.");
                          setLogEditMode(false);
                          onChanged(); // 상담탭과 동기화
                          setLogDetailId(null);
                        }
                      }}
                    >
                      저장
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" onClick={() => setLogDetailId(null)}>
                      닫기
                    </Button>
                    <Button
                      onClick={() => {
                        setLogEditText(detailLog?.note ?? "");
                        setLogEditMode(true);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5 mr-1" />
                      수정
                    </Button>
                  </>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        );
      })()}

      {/* 제공이력 상세보기·수정 다이얼로그 */}
      {(() => {
        const detailProv = provDetailId ? provisions.find((p) => p.id === provDetailId) : null;
        return (
          <Dialog
            open={!!provDetailId}
            onOpenChange={(open) => {
              if (!open) { setProvDetailId(null); setProvEditMode(false); setProvEditFields(null); }
            }}
          >
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-1.5">
                  <Package className="h-4 w-4 text-indigo-500" />
                  제공이력 상세
                </DialogTitle>
                <DialogDescription>
                  {detailProv ? `${detailProv.provided_at} · ${detailProv.category}` : ""}
                </DialogDescription>
              </DialogHeader>
              {detailProv && provEditFields && (
                <div className="space-y-3 py-1">
                  {provEditMode ? (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className="text-xs text-muted-foreground">제공일</label>
                          <input
                            type="date"
                            value={provEditFields.provided_at}
                            onChange={(e) => setProvEditFields((f) => f && ({ ...f, provided_at: e.target.value }))}
                            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs text-muted-foreground">분류</label>
                          <select
                            value={provEditFields.category}
                            onChange={(e) => setProvEditFields((f) => f && ({ ...f, category: e.target.value }))}
                            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                          >
                            {["후원물품","서비스","프로그램","현물지원","현금지원","기타"].map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-1 col-span-2">
                          <label className="text-xs text-muted-foreground">항목</label>
                          <input
                            value={provEditFields.title}
                            onChange={(e) => setProvEditFields((f) => f && ({ ...f, title: e.target.value }))}
                            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs text-muted-foreground">수량</label>
                          <input
                            value={provEditFields.quantity}
                            onChange={(e) => setProvEditFields((f) => f && ({ ...f, quantity: e.target.value }))}
                            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs text-muted-foreground">제공기관</label>
                          <input
                            value={provEditFields.agency}
                            onChange={(e) => setProvEditFields((f) => f && ({ ...f, agency: e.target.value }))}
                            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                          />
                        </div>
                        <div className="space-y-1 col-span-2">
                          <label className="text-xs text-muted-foreground">비고</label>
                          <input
                            value={provEditFields.note}
                            onChange={(e) => setProvEditFields((f) => f && ({ ...f, note: e.target.value }))}
                            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                          />
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-md bg-muted/40 p-3 space-y-2 text-sm">
                      <div className="flex gap-2"><span className="text-muted-foreground w-16 shrink-0">제공일</span><span>{detailProv.provided_at}</span></div>
                      <div className="flex gap-2"><span className="text-muted-foreground w-16 shrink-0">분류</span><Badge variant="outline">{detailProv.category}</Badge></div>
                      <div className="flex gap-2"><span className="text-muted-foreground w-16 shrink-0">항목</span><span className="font-medium">{detailProv.title}</span></div>
                      {detailProv.quantity && <div className="flex gap-2"><span className="text-muted-foreground w-16 shrink-0">수량</span><span>{detailProv.quantity}</span></div>}
                      {detailProv.agency && <div className="flex gap-2"><span className="text-muted-foreground w-16 shrink-0">제공기관</span><span>{detailProv.agency}</span></div>}
                      {detailProv.note && <div className="flex gap-2"><span className="text-muted-foreground w-16 shrink-0">비고</span><span>{detailProv.note}</span></div>}
                    </div>
                  )}
                </div>
              )}
              <DialogFooter className="flex-wrap gap-2">
                {provEditMode ? (
                  <>
                    <Button variant="outline" onClick={() => setProvEditMode(false)} disabled={provEditBusy}>취소</Button>
                    <Button
                      disabled={provEditBusy || !provEditFields?.title.trim()}
                      onClick={async () => {
                        if (!provDetailId || !provEditFields) return;
                        setProvEditBusy(true);
                        const { error } = await supabase.from("provisions").update({
                          provided_at: provEditFields.provided_at,
                          category: provEditFields.category,
                          title: provEditFields.title.trim(),
                          quantity: provEditFields.quantity.trim() || null,
                          agency: provEditFields.agency.trim() || null,
                          note: provEditFields.note.trim() || null,
                        }).eq("id", provDetailId);
                        setProvEditBusy(false);
                        if (error) { toast.error(error.message); return; }
                        toast.success("제공이력이 수정되었습니다.");
                        setProvEditMode(false);
                        setProvDetailId(null);
                        onChanged();
                      }}
                    >저장</Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" onClick={() => setProvDetailId(null)}>닫기</Button>
                    <Button onClick={() => setProvEditMode(true)}>
                      <Pencil className="h-3.5 w-3.5 mr-1" />수정
                    </Button>
                  </>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        );
      })()}

      {/* 욕구영역 수정/삭제 다이얼로그 */}
      <Dialog open={!!rowEdit} onOpenChange={(open) => { if (!open) { setRowEdit(null); setRowDeleteConfirm(false); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <Pencil className="h-4 w-4 text-primary" />
              욕구영역 수정
            </DialogTitle>
            <DialogDescription>
              우선순위 번호와 욕구영역 내용을 수정합니다.
            </DialogDescription>
          </DialogHeader>

          {!rowDeleteConfirm ? (
            <>
              <div className="space-y-3 py-1">
                <div>
                  <label className="text-sm font-medium">우선순위 번호 <span className="text-red-500">*</span></label>
                  <Input
                    type="number"
                    min={1}
                    className="mt-1.5"
                    value={rowEditPriority}
                    onChange={(e) => setRowEditPriority(e.target.value)}
                    placeholder="예: 1"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">욕구영역 내용 <span className="text-red-500">*</span></label>
                  <Input
                    className="mt-1.5"
                    value={rowEditNeed}
                    onChange={(e) => setRowEditNeed(e.target.value)}
                    placeholder="예: 경제적 상황 완화"
                    autoFocus
                    onKeyDown={(e) => { if (e.key === "Enter") saveEditRow(); }}
                  />
                </div>
              </div>
              <DialogFooter className="gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="mr-auto text-destructive border-destructive/40 hover:bg-destructive/10"
                  onClick={() => setRowDeleteConfirm(true)}
                  disabled={rowEditBusy}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />삭제
                </Button>
                <Button variant="outline" onClick={() => setRowEdit(null)} disabled={rowEditBusy}>
                  취소
                </Button>
                <Button onClick={saveEditRow} disabled={rowEditBusy}>
                  {rowEditBusy ? "저장 중…" : "저장"}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div className="py-3 space-y-2 rounded-md bg-destructive/5 border border-destructive/20 px-4">
                <p className="text-sm font-semibold text-destructive">이 욕구영역을 삭제하시겠습니까?</p>
                <p className="text-xs text-muted-foreground">포함된 행동계획 항목도 모두 함께 삭제되며 복구할 수 없습니다.</p>
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setRowDeleteConfirm(false)} disabled={rowEditBusy}>
                  취소
                </Button>
                <Button variant="destructive" onClick={deleteRow} disabled={rowEditBusy}>
                  {rowEditBusy ? "삭제 중…" : "정말 삭제"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

    </div>
  );
}
