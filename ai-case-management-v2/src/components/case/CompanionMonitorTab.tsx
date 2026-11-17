import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { analyzeCompanionChat, type CompanionAnalysis } from "@/lib/ai.functions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { AI_REFUSED_MESSAGE } from "@/lib/ai-consent";
import {
  HeartPulse,
  RefreshCw,
  Loader2,
  MessageSquare,
  Sparkles,
  AlertTriangle,
  ShieldCheck,
  Clock,
  Trash2,
  ExternalLink,
  Search,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  X,
  ArrowLeft,
} from "lucide-react";
import type { OrgRow } from "@/lib/case-types";
import { logView } from "@/lib/view-log";
import { AiModelBadge } from "@/components/AiModelBadge";
import {
  fetchMonitorList,
  fetchMonitorDetail,
  deleteCompanionSession,
  deleteCompanionMessage,
  highlightRiskKeywords,
  riskTone,
  riskRank,
  type MonitorItem,
  type MonitorMessage,
  type RiskLevel,
} from "@/lib/companion-monitor";

/** 로컬(브라우저=한국) 기준 연도/날짜 문자열 */
const localYear = (iso: string) => String(new Date(iso).getFullYear());
function localYmd(iso: string): string {
  const d = new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 날짜 구분선 레이블 */
function localDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", {
    year: "numeric", month: "long", day: "numeric", weekday: "long",
  });
}

/** 상대 시간 */
function ago(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "-";
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
  return new Date(iso).toLocaleDateString("ko-KR");
}

/** 대상자별 그룹 */
type ClientGroup = {
  key: string;
  name: string | null;
  verified: boolean;
  care_client_id: string | null;
  risk: RiskLevel;
  keywords: string[];
  sessions: MonitorItem[];
  last_active_at: string | null;
  msg_count: number;
  user_msg_count: number;
  last_user_message: string | null;
};

function groupItems(items: MonitorItem[]): ClientGroup[] {
  const map = new Map<string, ClientGroup>();
  for (const it of items) {
    const key = it.care_client_id ?? it.name ?? it.session_id;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        name: it.name,
        verified: it.verified,
        care_client_id: it.care_client_id,
        risk: it.risk,
        keywords: [...it.keywords],
        sessions: [it],
        last_active_at: it.last_active_at,
        msg_count: it.msg_count,
        user_msg_count: it.user_msg_count,
        last_user_message: it.last_user_message,
      });
    } else {
      existing.sessions.push(it);
      existing.msg_count += it.msg_count;
      existing.user_msg_count += it.user_msg_count;
      if ((it.last_active_at ?? "") > (existing.last_active_at ?? "")) {
        existing.last_active_at = it.last_active_at;
        existing.last_user_message = it.last_user_message;
      }
      if (riskRank(it.risk) > riskRank(existing.risk)) existing.risk = it.risk;
      for (const k of it.keywords) {
        if (!existing.keywords.includes(k)) existing.keywords.push(k);
      }
    }
  }
  // 가장 최근에 이용한 어르신이 맨 위. 위험 단계는 각 줄의 표시와 상단 건수로 확인한다.
  return [...map.values()].sort(
    (a, b) =>
      (b.last_active_at ?? "").localeCompare(a.last_active_at ?? "") ||
      riskRank(b.risk) - riskRank(a.risk),
  );
}

type Props = {
  org: OrgRow | null;
  isAdmin?: boolean;
  onGoToClient?: (clientId: string) => void;
  workerName?: string;
};

export function CompanionMonitorTab({ org, isAdmin = false, onGoToClient, workerName = "" }: Props) {
  const joinCode = org?.join_code ?? "";
  const orgId = org?.id ?? "";

  // ── 목록 데이터 ──────────────────────────────
  const [items, setItems] = useState<MonitorItem[]>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [errReason, setErrReason] = useState<string>("");

  const loadHidden = useCallback(async () => {
    if (!orgId) return;
    const { data } = await supabase
      .from("companion_hidden_sessions")
      .select("session_id")
      .eq("org_id", orgId);
    if (data) setHiddenIds(new Set(data.map((r) => r.session_id)));
  }, [orgId]);

  // ── 확인완료(ack) 상태 — load보다 먼저 선언해야 deps 배열에서 TDZ 없음 ──
  type AckMap = Record<string, { acked_at: string; risk_level: string }>;
  const [ackMap, setAckMap] = useState<AckMap>({});
  const [acking, setAcking] = useState(false);

  const loadAcks = useCallback(async (sessionIds: string[]) => {
    if (sessionIds.length === 0) return;
    const { data } = await supabase
      .from("companion_ack")
      .select("session_id, risk_level, acked_at")
      .eq("org_id", orgId)
      .in("session_id", sessionIds);
    if (data) {
      const map: AckMap = {};
      for (const row of data) map[row.session_id] = { acked_at: row.acked_at, risk_level: row.risk_level };
      setAckMap(map);
    }
  }, [orgId]);

  const load = useCallback(async () => {
    if (!joinCode) { setLoading(false); setErrReason("no_org"); return; }
    setLoading(true);
    setErrReason("");
    try {
      const [{ items: fetched }] = await Promise.all([
        fetchMonitorList(supabase, joinCode),
        loadHidden(),
      ]);
      setItems(fetched);
      await loadAcks(fetched.map((i) => i.session_id));
    } catch (e) {
      setErrReason((e as Error).message || "unknown");
    } finally {
      setLoading(false);
    }
  }, [joinCode, loadHidden, loadAcks]);

  useEffect(() => { load(); }, [load]);

  // ── 필터 상태 ─────────────────────────────────
  const [verifiedOnly, setVerifiedOnly]  = useState(false);
  const [search, setSearch]              = useState("");
  const [showHidden, setShowHidden]      = useState(false);

  // ── 위험도 명단 다이얼로그 ───────────────────
  const [riskDialogLevel, setRiskDialogLevel] = useState<Exclude<RiskLevel, "정상"> | null>(null);

  /** 세션의 ack가 last_active_at 이후이면 "확인됨" (새 메시지 없음) */
  function isSessionAcked(session: MonitorItem): boolean {
    const ack = ackMap[session.session_id];
    if (!ack) return false;
    return !session.last_active_at || ack.acked_at >= session.last_active_at;
  }

  /** 그룹의 위험 세션이 전부 확인됐으면 effectiveRisk = "정상" */
  function getEffectiveRisk(g: ClientGroup): RiskLevel {
    if (g.risk === "정상") return "정상";
    const riskySessions = g.sessions.filter((s) => s.risk !== "정상");
    if (riskySessions.length === 0) return "정상";
    return riskySessions.every(isSessionAcked) ? "정상" : g.risk;
  }

  // ── 그룹핑 ───────────────────────────────────
  const groups = useMemo(() => {
    const visible = items.filter(
      (i) => !hiddenIds.has(i.session_id) && (!verifiedOnly || i.verified),
    );
    return groupItems(visible);
  }, [items, hiddenIds, verifiedOnly]);

  const hiddenItems = useMemo(
    () => items.filter((i) => hiddenIds.has(i.session_id)),
    [items, hiddenIds],
  );

  const visibleSummary = useMemo(() => ({
    total: groups.length,
    경고: groups.filter((g) => getEffectiveRisk(g) === "경고").length,
    주의: groups.filter((g) => getEffectiveRisk(g) === "주의").length,
    점검: groups.filter((g) => getEffectiveRisk(g) === "점검").length,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [groups, ackMap]);

  const filteredGroups = useMemo(() => {
    let list = groups;
    if (search.trim()) list = list.filter((g) => (g.name ?? "").includes(search.trim()));
    // 확인이 필요한 경고·주의·점검은 맨 위로(경고 → 주의 → 점검, 같은 단계는 최근 이용 순).
    // 확인이 끝나면(또는 확인 뒤 새 대화가 없으면) 나머지와 함께 최근 이용 순에 섞인다.
    // groups 는 이미 최근 이용 순이고 정렬은 안정적이라 같은 단계 안의 순서는 그대로 유지된다.
    const pending = list.filter((g) => getEffectiveRisk(g) !== "정상");
    if (pending.length === 0) return list;
    pending.sort((a, b) => riskRank(getEffectiveRisk(b)) - riskRank(getEffectiveRisk(a)));
    return [...pending, ...list.filter((g) => getEffectiveRisk(g) === "정상")];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, search, ackMap]);

  // ── 선택된 어르신 ─────────────────────────────
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedGroup = useMemo(
    () => filteredGroups.find((g) => g.key === selectedKey) ?? null,
    [filteredGroups, selectedKey],
  );

  // ── 우측 채팅 패널 ────────────────────────────
  const [detail, setDetail]         = useState<{ name: string; messages: MonitorMessage[] } | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [openSid, setOpenSid]       = useState<string | null>(null);       // 현재 열린 session_id
  const [yearF, setYearF]           = useState("all");
  const [dateF, setDateF]           = useState("all");
  const [aiBusy, setAiBusy]         = useState(false);

  // ── AI 분석 결과 목록 (period별 저장, localStorage 유지) ────────────
  type AnalysisRecord = { period: string; result: CompanionAnalysis; collapsed: boolean; analyzedAt: string; analyzedBy: string };
  const [analyses, setAnalyses]     = useState<AnalysisRecord[]>([]);

  function analysesKey(sid: string) { return `companion_analyses_${sid}`; }

  function loadAnalyses(sid: string) {
    try {
      const raw = localStorage.getItem(analysesKey(sid));
      if (!raw) return [];
      return (JSON.parse(raw) as AnalysisRecord[]).map((r) => ({ ...r, collapsed: true }));
    } catch { return []; }
  }

  function saveAnalyses(sid: string, list: AnalysisRecord[]) {
    try { localStorage.setItem(analysesKey(sid), JSON.stringify(list)); } catch { /* ignore */ }
  }
  const [deletingMsgId, setDeletingMsgId] = useState<string | null>(null);
  const [isSelectMode, setIsSelectMode]   = useState(false);
  const [selectedMsgIds, setSelectedMsgIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting]   = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const runAnalyze = useServerFn(analyzeCompanionChat);

  async function openDetail(sid: string) {
    if (openSid === sid) return;
    logView({
      action: "복순이 대화 열람",
      client: selectedGroup?.care_client_id ? { id: selectedGroup.care_client_id } : null,
    });
    setOpenSid(sid);
    setDetail(null);
    setAnalyses(loadAnalyses(sid));
    setYearF("all");
    setDateF("all");
    exitSelectMode();
    setDetailBusy(true);
    try {
      const d = await fetchMonitorDetail(supabase, joinCode, sid);
      setDetail(d);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    } catch (e) {
      toast.error("대화를 불러오지 못했어요: " + (e as Error).message);
      setOpenSid(null);
    } finally {
      setDetailBusy(false);
    }
  }

  // ── 폴링: 왼쪽 목록 30초마다 자동 갱신 ──────────────
  useEffect(() => {
    if (!joinCode) return;
    const timer = setInterval(async () => {
      try {
        const { items: next } = await fetchMonitorList(supabase, joinCode);
        setItems(next);
      } catch { /* 갱신 실패 시 조용히 무시 */ }
    }, 30_000);
    return () => clearInterval(timer);
  }, [joinCode]);

  // ── 폴링: 열린 세션 채팅 10초마다 새 메시지 확인 ───
  useEffect(() => {
    if (!openSid || !joinCode) return;
    const timer = setInterval(async () => {
      try {
        const d = await fetchMonitorDetail(supabase, joinCode, openSid);
        setDetail((prev) => {
          if (!prev) return d;
          // 새 메시지가 있을 때만 업데이트
          if (d.messages.length === prev.messages.length) return prev;
          setTimeout(
            () => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }),
            80,
          );
          return d;
        });
      } catch { /* 갱신 실패 시 무시 */ }
    }, 10_000);
    return () => clearInterval(timer);
  }, [openSid, joinCode]);

  // 그룹 클릭 → 가장 최근 세션 열기
  function handleSelectGroup(g: ClientGroup) {
    setSelectedKey(g.key);
    const sorted = [...g.sessions].sort(
      (a, b) => (b.last_active_at ?? "").localeCompare(a.last_active_at ?? ""),
    );
    openDetail(sorted[0].session_id);
  }

  // 메시지 필터 계산
  const msgs = detail?.messages ?? [];
  const years = [...new Set(msgs.map((m) => localYear(m.created_at)))].sort().reverse();
  const datesInYear = [
    ...new Set(
      msgs
        .filter((m) => yearF === "all" || localYear(m.created_at) === yearF)
        .map((m) => localYmd(m.created_at)),
    ),
  ].sort().reverse();
  const filtered = msgs.filter((m) => {
    if (yearF !== "all" && localYear(m.created_at) !== yearF) return false;
    if (dateF !== "all" && localYmd(m.created_at) !== dateF) return false;
    return true;
  });

  async function analyzeFiltered() {
    if (!detail || !openSid) return;
    const transcript = filtered
      .map((m) => `${m.role === "user" ? "어르신" : "복순이"}: ${m.content}`)
      .join("\n");
    if (transcript.trim().length < 20)
      return toast.error("분석할 대화가 부족합니다. 기간을 넓혀보세요.");
    const period =
      [yearF !== "all" ? `${yearF}년` : "", dateF !== "all" ? dateF : ""]
        .filter(Boolean).join(" ") || "전체 기간";
    setAiBusy(true);
    try {
      const r = await runAnalyze({ data: { name: detail.name, period, transcript, clientId: selectedGroup?.care_client_id ?? undefined } });
      const newRecord: AnalysisRecord = { period, result: r, collapsed: false, analyzedAt: new Date().toISOString(), analyzedBy: workerName };
      setAnalyses((prev) => {
        const idx = prev.findIndex((a) => a.period === period);
        const next = idx >= 0
          ? prev.map((a, i) => i === idx ? newRecord : a)
          : [newRecord, ...prev];
        saveAnalyses(openSid, next);
        return next;
      });
    } catch (e) {
      const msg = (e as Error).message || "";
      toast.error(
        msg.includes(AI_REFUSED_MESSAGE) ? AI_REFUSED_MESSAGE :
        /GEMINI_API_KEY missing/.test(msg) ? "제미나이 키가 필요합니다." :
        /429|quota/i.test(msg) ? "제미나이 사용량 초과 — 잠시 후 다시 시도해 주세요." :
        "분석 실패: " + msg,
      );
    } finally {
      setAiBusy(false);
    }
  }

  async function deleteMsg(msgId: string | undefined) {
    if (!msgId) return toast.error("삭제할 수 없는 메시지입니다 (ID 없음)");
    if (!openSid) return;
    if (!confirm("이 메시지를 복순이 앱에서도 완전히 삭제하시겠습니까?")) return;
    setDeletingMsgId(msgId);
    try {
      await deleteCompanionMessage(supabase, msgId, openSid, joinCode);
      setDetail((prev) =>
        prev ? { ...prev, messages: prev.messages.filter((m) => m.id !== msgId) } : prev
      );
      toast.success("메시지가 삭제되었습니다.");
    } catch (e) {
      toast.error("삭제 실패: " + (e as Error).message);
    } finally {
      setDeletingMsgId(null);
    }
  }

  // 선택 모드 초기화
  function exitSelectMode() {
    setIsSelectMode(false);
    setSelectedMsgIds(new Set());
  }

  function toggleSelectMsg(id: string) {
    setSelectedMsgIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function bulkDeleteMsgs() {
    if (!openSid || selectedMsgIds.size === 0) return;
    if (!confirm(`선택한 ${selectedMsgIds.size}개 메시지를 복순이 앱에서도 완전히 삭제하시겠습니까?`)) return;
    setBulkDeleting(true);
    let failCount = 0;
    for (const id of selectedMsgIds) {
      try {
        await deleteCompanionMessage(supabase, id, openSid, joinCode);
      } catch {
        failCount++;
      }
    }
    setDetail((prev) =>
      prev ? { ...prev, messages: prev.messages.filter((m) => !m.id || !selectedMsgIds.has(m.id)) } : prev
    );
    setBulkDeleting(false);
    exitSelectMode();
    if (failCount > 0) toast.error(`${failCount}개 삭제 실패`);
    else toast.success(`${selectedMsgIds.size}개 메시지가 삭제되었습니다.`);
  }

  // ── 확인완료 처리 ────────────────────────────
  async function ackGroup(g: ClientGroup) {
    const riskySessions = g.sessions.filter((s) => s.risk !== "정상");
    if (riskySessions.length === 0) return;
    setAcking(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const now = new Date().toISOString();
      for (const s of riskySessions) {
        await supabase.from("companion_ack").upsert(
          { session_id: s.session_id, org_id: orgId, risk_level: s.risk, acked_by: user?.id, acked_at: now },
          { onConflict: "session_id" },
        );
      }
      setAckMap((prev) => {
        const next = { ...prev };
        for (const s of riskySessions) next[s.session_id] = { acked_at: now, risk_level: s.risk };
        return next;
      });
      toast.success("확인 완료로 표시했습니다. 새 위험 메시지가 오면 자동으로 경고가 다시 표시됩니다.");
    } catch (e) {
      toast.error("처리 실패: " + (e as Error).message);
    } finally {
      setAcking(false);
    }
  }

  // ── 세션 숨김/복원/영구삭제 ───────────────────
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [permDeletingId, setPermDeletingId] = useState<string | null>(null);

  async function hideSession(sessionId: string) {
    if (!confirm("이 대화 세션을 목록에서 숨기겠습니까?")) return;
    setDeletingId(sessionId);
    const { error } = await supabase.from("companion_hidden_sessions").insert({ session_id: sessionId, org_id: orgId });
    setDeletingId(null);
    if (error) return toast.error("숨김 실패: " + error.message);
    setHiddenIds((prev) => new Set([...prev, sessionId]));
    if (openSid === sessionId) { setOpenSid(null); setDetail(null); setSelectedKey(null); }
    toast.success("대화가 목록에서 숨겨졌습니다.");
  }

  async function restoreSession(sessionId: string) {
    setRestoringId(sessionId);
    const { error } = await supabase.from("companion_hidden_sessions")
      .delete().eq("session_id", sessionId).eq("org_id", orgId);
    setRestoringId(null);
    if (error) return toast.error("복원 실패: " + error.message);
    setHiddenIds((prev) => { const next = new Set(prev); next.delete(sessionId); return next; });
    toast.success("대화가 복원되었습니다.");
  }

  async function permanentDelete(sessionId: string, name: string | null) {
    if (!confirm(
      `"${name || "이름 미상"}" 어르신의 대화를 완전히 삭제하시겠습니까?\n복순이 앱의 대화 내용도 삭제되며 복원할 수 없습니다.`
    )) return;
    setPermDeletingId(sessionId);
    try {
      await deleteCompanionSession(supabase, sessionId);
      await supabase.from("companion_hidden_sessions").delete()
        .eq("session_id", sessionId).eq("org_id", orgId);
      setHiddenIds((prev) => { const next = new Set(prev); next.delete(sessionId); return next; });
      setItems((prev) => prev.filter((i) => i.session_id !== sessionId));
      if (openSid === sessionId) { setOpenSid(null); setDetail(null); setSelectedKey(null); }
      toast.success("대화가 완전히 삭제되었습니다.");
    } catch (e) {
      toast.error("삭제 실패: " + (e as Error).message);
    } finally {
      setPermDeletingId(null);
    }
  }

  // ── 에러 ─────────────────────────────────────
  if (!loading && errReason) {
    return <SetupNotice reason={errReason} joinCode={joinCode} onRetry={load} />;
  }

  // ── 렌더 ─────────────────────────────────────
  return (
    <div className="flex flex-col gap-3" style={{ height: "calc(100dvh - 13rem)" }}>
      {/* 상단: 헤더 + 요약 통계 */}
      <div className="space-y-2 shrink-0">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <HeartPulse className="h-5 w-5 text-primary" />
            <div>
              <div className="font-semibold">복순이 모니터링</div>
              <div className="text-[11px] text-muted-foreground">
                말벗 챗봇 이용 어르신 · 우리 기관 인증({joinCode}) 대상
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={verifiedOnly}
                onChange={(e) => setVerifiedOnly(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
              />
              인증 어르신만
            </label>
            {isAdmin && hiddenItems.length > 0 && (
              <Button size="sm" variant={showHidden ? "secondary" : "outline"} className="h-8 gap-1"
                onClick={() => setShowHidden((v) => !v)}>
                <Trash2 className="h-3.5 w-3.5" />
                숨긴 목록 {hiddenItems.length}건
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              새로고침
            </Button>
          </div>
        </div>

        {/* 요약 통계 카드 — 위험 카드는 숫자 있으면 클릭 시 명단 */}
        <div className="grid grid-cols-4 gap-2">
          <StatCard label="이용 어르신" value={visibleSummary.total} tone="border-border" />
          <StatCard label="경고" value={visibleSummary.경고} tone="border-red-300 bg-red-50 text-red-700"
            onClick={visibleSummary.경고 > 0 ? () => setRiskDialogLevel("경고") : undefined} />
          <StatCard label="주의" value={visibleSummary.주의} tone="border-amber-300 bg-amber-50 text-amber-700"
            onClick={visibleSummary.주의 > 0 ? () => setRiskDialogLevel("주의") : undefined} />
          <StatCard label="점검 필요" value={visibleSummary.점검} tone="border-sky-300 bg-sky-50 text-sky-700"
            onClick={visibleSummary.점검 > 0 ? () => setRiskDialogLevel("점검") : undefined} />
        </div>
      </div>

      {/* 2분할 메인 영역 */}
      <div className="flex min-h-0 flex-1 gap-0 rounded-lg border border-border overflow-hidden">

        {/* ── 왼쪽: 어르신 목록 — 모바일에서 어르신 선택 시 숨김 ── */}
        <div className={`flex-col border-r border-border bg-card ${selectedKey ? "hidden sm:flex sm:w-64 sm:shrink-0" : "flex w-full sm:w-64 sm:shrink-0"}`}>
          {/* 검색 */}
          <div className="p-2 border-b border-border">
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="이름 검색"
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>

          {/* 목록 */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 mx-auto mb-1.5 animate-spin opacity-50" />
                불러오는 중...
              </div>
            ) : filteredGroups.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                <HeartPulse className="h-5 w-5 mx-auto mb-1.5 opacity-30" />
                {search ? "검색 결과 없음" : "등록된 어르신이 없어요"}
              </div>
            ) : (
              filteredGroups.map((g) => (
                <SeniorListItem
                  key={g.key}
                  g={g}
                  effectiveRisk={getEffectiveRisk(g)}
                  selected={selectedKey === g.key}
                  onClick={() => handleSelectGroup(g)}
                />
              ))
            )}
          </div>

          {/* 숨긴 세션 (관리자) */}
          {isAdmin && showHidden && hiddenItems.length > 0 && (
            <div className="border-t border-border p-2 space-y-1.5 max-h-40 overflow-y-auto">
              <p className="text-[10px] font-medium text-muted-foreground">숨긴 대화 ({hiddenItems.length}건)</p>
              {hiddenItems.map((it) => (
                <div key={it.session_id}
                  className="flex items-center justify-between gap-1 rounded-md border border-border bg-accent/20 px-2 py-1.5 text-xs">
                  <span className="truncate font-medium">{it.name || "이름 미상"}</span>
                  <div className="flex gap-1 shrink-0">
                    <button type="button" onClick={() => restoreSession(it.session_id)}
                      disabled={restoringId === it.session_id || permDeletingId === it.session_id}
                      className="text-primary hover:underline text-[10px] disabled:opacity-40">
                      복원
                    </button>
                    <button type="button" onClick={() => permanentDelete(it.session_id, it.name)}
                      disabled={restoringId === it.session_id || permDeletingId === it.session_id}
                      className="text-destructive hover:underline text-[10px] disabled:opacity-40">
                      삭제
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── 오른쪽: 채팅 뷰 — 모바일에서 어르신 선택 전 숨김 ── */}
        <div className={`min-h-0 flex-1 flex-col bg-background ${selectedKey ? "flex" : "hidden sm:flex"}`}>
          {!selectedGroup ? (
            /* 선택 안내 — 데스크탑 전용 (모바일에서는 이 패널 자체가 hidden) */
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <MessageSquare className="h-10 w-10 opacity-20" />
              <p className="text-sm">왼쪽에서 어르신을 선택하세요</p>
            </div>
          ) : (
            <>
              {/* 어르신 정보 헤더 */}
              <div className="shrink-0 border-b border-border bg-card px-3 py-2 sm:px-4 sm:py-3">
                {/* 모바일: 목록으로 돌아가기 */}
                <button
                  type="button"
                  onClick={() => setSelectedKey(null)}
                  className="sm:hidden flex items-center gap-1 text-xs text-muted-foreground mb-1 hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  목록으로
                </button>
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2.5">
                    {/* 이니셜 아바타 — 모바일 숨김 */}
                    {(() => {
                      const er = getEffectiveRisk(selectedGroup);
                      return (
                        <div className={`hidden sm:flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold shrink-0 ${
                          er === "경고" ? "bg-red-100 text-red-700" :
                          er === "주의" ? "bg-amber-100 text-amber-700" :
                          er === "점검" ? "bg-sky-100 text-sky-700" :
                          "bg-primary/10 text-primary"
                        }`}>
                          {(selectedGroup.name ?? "?").charAt(0)}
                        </div>
                      );
                    })()}
                    <div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold text-foreground">
                          {selectedGroup.name || "이름 미상"}
                        </span>
                        <RiskBadge risk={getEffectiveRisk(selectedGroup)} />
                        {selectedGroup.verified && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-primary/40 text-primary">
                            <ShieldCheck className="h-3 w-3 mr-0.5" />인증
                          </Badge>
                        )}
                      </div>
                      {/* 대화 건수 — 모바일 숨김 */}
                      <div className="hidden sm:flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                        <span className="inline-flex items-center gap-0.5">
                          <Clock className="h-3 w-3" /> {ago(selectedGroup.last_active_at)}
                        </span>
                        <span>대화 {selectedGroup.msg_count}건 · 어르신 발화 {selectedGroup.user_msg_count}건</span>
                        {selectedGroup.sessions.length > 1 && (
                          <span>세션 {selectedGroup.sessions.length}개</span>
                        )}
                      </div>
                      {/* 모바일: 마지막 접촉 시간만 간략 표시 */}
                      <div className="sm:hidden text-[11px] text-muted-foreground mt-0.5 inline-flex items-center gap-0.5">
                        <Clock className="h-3 w-3" /> {ago(selectedGroup.last_active_at)}
                        <span className="ml-1">· 대화 {selectedGroup.msg_count}건</span>
                      </div>
                    </div>
                  </div>

                  {/* 우측 버튼들 */}
                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                    {/* 확인완료 버튼 — 위험이 있을 때만 표시 */}
                    {selectedGroup.risk !== "정상" && (() => {
                      const acked = getEffectiveRisk(selectedGroup) === "정상";
                      return (
                        <button
                          type="button"
                          onClick={() => !acked && ackGroup(selectedGroup)}
                          disabled={acked || acking}
                          className={`h-8 px-2.5 inline-flex items-center gap-1 text-xs border rounded-md transition-colors disabled:opacity-60 ${
                            acked
                              ? "border-emerald-300 bg-emerald-50 text-emerald-700 cursor-default"
                              : "border-border text-muted-foreground hover:border-emerald-400 hover:text-emerald-700 hover:bg-emerald-50"
                          }`}
                        >
                          {acking
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <CheckCircle2 className="h-3.5 w-3.5" />}
                          <span className="hidden sm:inline">{acked ? "확인됨" : "확인완료"}</span>
                        </button>
                      );
                    })()}
                    {onGoToClient && selectedGroup.verified && selectedGroup.care_client_id && (
                      <button type="button"
                        onClick={() => onGoToClient(selectedGroup.care_client_id!)}
                        className="h-8 px-2.5 inline-flex items-center gap-1 text-xs text-primary border border-primary/30 rounded-md hover:bg-primary/5 transition-colors">
                        <ExternalLink className="h-3.5 w-3.5" /> <span className="hidden sm:inline">케어 기록</span>
                      </button>
                    )}
                    {isAdmin && (
                      <button type="button"
                        onClick={() => {
                          const sid = [...selectedGroup.sessions].sort(
                            (a, b) => (b.last_active_at ?? "").localeCompare(a.last_active_at ?? "")
                          )[0].session_id;
                          hideSession(sid);
                        }}
                        disabled={!!deletingId}
                        className="h-8 px-2.5 inline-flex items-center gap-1 text-xs text-muted-foreground border border-border rounded-md hover:text-destructive hover:border-destructive/30 transition-colors disabled:opacity-40">
                        {deletingId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        <span className="hidden sm:inline">숨김</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* 키워드 — 모바일 숨김 */}
                {selectedGroup.keywords.length > 0 && (
                  <div className="hidden sm:flex flex-wrap gap-1 mt-2">
                    {selectedGroup.keywords.slice(0, 8).map((k) => (
                      <span key={k} className="text-[10px] rounded-full border border-border px-1.5 py-0.5 text-muted-foreground">
                        {k}
                      </span>
                    ))}
                  </div>
                )}

                {/* 세션이 여러 개일 때 세션 탭 — 모바일 숨김 */}
                {selectedGroup.sessions.length > 1 && (
                  <div className="hidden sm:flex gap-1 mt-2 flex-wrap">
                    {[...selectedGroup.sessions]
                      .sort((a, b) => (b.last_active_at ?? "").localeCompare(a.last_active_at ?? ""))
                      .map((s, i) => (
                        <button key={s.session_id} type="button"
                          onClick={() => openDetail(s.session_id)}
                          className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                            openSid === s.session_id
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border text-muted-foreground hover:bg-accent"
                          }`}>
                          세션 {i + 1} · {ago(s.last_active_at)}
                        </button>
                      ))}
                  </div>
                )}
              </div>

              {/* 날짜 필터 + AI 분석 */}
              <div className="shrink-0 flex items-center gap-1.5 flex-wrap border-b border-border px-3 py-1.5 sm:px-4 sm:py-2 bg-muted/20">
                <span className="text-[11px] text-muted-foreground">기간</span>
                <Select value={yearF} onValueChange={(v) => { setYearF(v); setDateF("all"); }}>
                  <SelectTrigger className="h-7 w-[6.5rem] text-xs">
                    <SelectValue placeholder="연도" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">전체 연도</SelectItem>
                    {years.map((y) => <SelectItem key={y} value={y}>{y}년</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={dateF} onValueChange={setDateF}>
                  <SelectTrigger className="h-7 w-[8.5rem] text-xs">
                    <SelectValue placeholder="날짜" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">전체 날짜</SelectItem>
                    {datesInYear.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
                <span className="text-[11px] text-muted-foreground">{filtered.length}개</span>
                <div className="ml-auto flex items-center gap-1.5">
                  {isAdmin && !isSelectMode && (
                    <Button size="sm" variant="outline" className="h-7 text-xs"
                      onClick={() => setIsSelectMode(true)}
                      disabled={!detail || filtered.length === 0}>
                      <Trash2 className="h-3.5 w-3.5" />
                      선택 삭제
                    </Button>
                  )}
                  {isAdmin && isSelectMode && (() => {
                    const selectableIds = filtered.filter((m) => !!m.id).map((m) => m.id!);
                    const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedMsgIds.has(id));
                    return (
                      <>
                        <button type="button" onClick={exitSelectMode}
                          className="h-7 px-2 text-xs text-muted-foreground border border-border rounded-md hover:bg-accent transition-colors">
                          취소
                        </button>
                        <button type="button"
                          onClick={() => {
                            if (allSelected) {
                              setSelectedMsgIds(new Set());
                            } else {
                              setSelectedMsgIds(new Set(selectableIds));
                            }
                          }}
                          className="h-7 px-2 text-xs border border-border rounded-md hover:bg-accent transition-colors">
                          {allSelected ? "전체 해제" : "전체 선택"}
                        </button>
                        <Button size="sm" variant="destructive" className="h-7 text-xs"
                          onClick={bulkDeleteMsgs}
                          disabled={selectedMsgIds.size === 0 || bulkDeleting}>
                          {bulkDeleting
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Trash2 className="h-3.5 w-3.5" />}
                          {selectedMsgIds.size > 0 ? `${selectedMsgIds.size}개 삭제` : "삭제"}
                        </Button>
                      </>
                    );
                  })()}
                  {!isSelectMode && (
                    <Button size="sm" className="h-7 text-xs" onClick={analyzeFiltered}
                      disabled={aiBusy || !detail || filtered.length === 0}>
                      {aiBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                      AI 분석
                    </Button>
                  )}
                  {!isSelectMode && <AiModelBadge />}
                </div>
              </div>

              {/* AI 분석 결과 목록 */}
              {analyses.length > 0 && (
                <div className="shrink-0 border-b border-border px-4 py-2 space-y-2 max-h-[40%] overflow-y-auto">
                  {analyses.map((rec, idx) => (
                    <div key={rec.period} className="rounded-md border border-primary/30 bg-primary/5">
                      {/* 카드 헤더 */}
                      <div className="flex items-center justify-between px-3 py-1.5">
                        <button
                          type="button"
                          onClick={() => setAnalyses((prev) => {
                            const next = prev.map((a, i) => i === idx ? { ...a, collapsed: !a.collapsed } : a);
                            if (openSid) saveAnalyses(openSid, next);
                            return next;
                          })}
                          className="flex items-center gap-1.5 text-xs font-semibold text-primary flex-1 text-left min-w-0"
                        >
                          <Sparkles className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">
                            AI 분석 · {rec.period}
                            {rec.analyzedAt && (
                              <span className="font-normal text-muted-foreground ml-1.5">
                                {new Date(rec.analyzedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                                {rec.analyzedBy && ` · ${rec.analyzedBy}`}
                              </span>
                            )}
                          </span>
                          {rec.collapsed
                            ? <ChevronDown className="h-3.5 w-3.5 ml-auto shrink-0 opacity-60" />
                            : <ChevronUp className="h-3.5 w-3.5 ml-auto shrink-0 opacity-60" />}
                        </button>
                        <button
                          type="button"
                          title="분석 삭제"
                          onClick={() => setAnalyses((prev) => {
                            const next = prev.filter((_, i) => i !== idx);
                            if (openSid) saveAnalyses(openSid, next);
                            return next;
                          })}
                          className="ml-2 shrink-0 h-5 w-5 flex items-center justify-center rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground transition-colors"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      {/* 카드 본문 */}
                      {!rec.collapsed && (
                        <div className="px-3 pb-3">
                          <AnalysisCard a={rec.result} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* 채팅 메시지 */}
              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
                {detailBusy ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    <Loader2 className="h-5 w-5 mx-auto mb-2 animate-spin opacity-50" />
                    대화를 불러오는 중...
                  </div>
                ) : filtered.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    선택한 기간에 대화가 없습니다.
                  </p>
                ) : (
                  <>
                    {filtered.map((m, i) => {
                      const isUser = m.role === "user";
                      const showDate =
                        i === 0 || localYmd(m.created_at) !== localYmd(filtered[i - 1].created_at);
                      const timeStr = new Date(m.created_at).toLocaleTimeString("ko-KR", {
                        hour: "2-digit", minute: "2-digit",
                      });
                      return (
                        <div key={m.id ?? i}>
                          {/* 날짜 구분선 */}
                          {showDate && (
                            <div className="flex items-center gap-2 my-4">
                              <div className="flex-1 h-px bg-border" />
                              <span className="text-[10px] text-muted-foreground px-2 shrink-0">
                                {localDateLabel(m.created_at)}
                              </span>
                              <div className="flex-1 h-px bg-border" />
                            </div>
                          )}
                          {/* 말풍선 행 */}
                          {isSelectMode && m.id ? (
                            /* 선택 모드: 체크박스 + 말풍선 전체 클릭으로 선택 */
                            <button
                              type="button"
                              onClick={() => toggleSelectMsg(m.id!)}
                              className={`flex w-full items-center gap-2 rounded-xl px-2 py-1 transition-colors text-left ${
                                selectedMsgIds.has(m.id)
                                  ? "bg-destructive/10"
                                  : "hover:bg-accent/50"
                              } ${isUser ? "flex-row-reverse" : "flex-row"}`}
                            >
                              <input
                                type="checkbox"
                                readOnly
                                checked={selectedMsgIds.has(m.id)}
                                className="h-4 w-4 shrink-0 accent-destructive cursor-pointer"
                              />
                              <div className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap shadow-sm ${
                                isUser
                                  ? "rounded-br-sm bg-primary/10 border border-primary/20"
                                  : "rounded-bl-sm bg-card border border-border"
                              } ${selectedMsgIds.has(m.id) ? "opacity-60" : ""}`}>
                                {m.content}
                              </div>
                              <span className="text-[10px] text-muted-foreground shrink-0">{timeStr}</span>
                            </button>
                          ) : (
                          <div className={`flex items-end gap-1.5 ${isUser ? "justify-end" : "justify-start"}`}>
                            {/* 복순이: 시간이 말풍선 오른쪽(아래) */}
                            {!isUser && (
                              <span className="text-[10px] text-muted-foreground shrink-0 mb-1">{timeStr}</span>
                            )}
                            {/* 말풍선 */}
                            <div className={`relative max-w-[75%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap shadow-sm ${
                              isUser
                                ? "rounded-br-sm bg-primary/10 border border-primary/20"
                                : "rounded-bl-sm bg-card border border-border"
                            }`}>
                              {/* 삭제 버튼 — 말풍선 안 우상단 (폰 터치 가능) */}
                              {isAdmin && (
                                <button
                                  type="button"
                                  onClick={() => deleteMsg(m.id)}
                                  disabled={deletingMsgId === m.id}
                                  className="absolute -top-2 -right-2 h-5 w-5 flex items-center justify-center rounded-full bg-muted border border-border text-muted-foreground hover:bg-destructive hover:text-white hover:border-destructive transition-colors shadow-sm disabled:opacity-40"
                                >
                                  {deletingMsgId === m.id
                                    ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                    : <span className="text-[9px] font-bold leading-none">✕</span>}
                                </button>
                              )}
                              {/* 어르신 발화만 위험 키워드 하이라이트 */}
                              {isUser
                                ? highlightRiskKeywords(m.content).map((seg, si) =>
                                    seg.level ? (
                                      <mark key={si} className={`rounded-sm px-0.5 not-italic font-semibold ${
                                        seg.level === "경고" ? "bg-red-200 text-red-900" :
                                        seg.level === "주의" ? "bg-amber-200 text-amber-900" :
                                        "bg-sky-200 text-sky-900"
                                      }`}>{seg.part}</mark>
                                    ) : <span key={si}>{seg.part}</span>
                                  )
                                : m.content}
                            </div>
                            {/* 어르신: 시간이 말풍선 왼쪽(아래) */}
                            {isUser && (
                              <span className="text-[10px] text-muted-foreground shrink-0 mb-1">{timeStr}</span>
                            )}
                          </div>
                          )}
                        </div>
                      );
                    })}
                    <div ref={chatEndRef} />
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground shrink-0">
        위험 분류는 발화 키워드 기반 자동 추정입니다. 정확한 판단은 AI 분석으로 확인하세요.
        {isAdmin && " · 숨김 버튼으로 대화를 목록에서 숨길 수 있습니다(관리자 전용)."}
      </p>

      {/* ── 위험도별 명단 다이얼로그 ── */}
      <Dialog open={!!riskDialogLevel} onOpenChange={(o) => { if (!o) setRiskDialogLevel(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1 text-sm font-semibold px-2 py-0.5 rounded-full ${
                riskDialogLevel === "경고" ? "bg-red-100 text-red-700" :
                riskDialogLevel === "주의" ? "bg-amber-100 text-amber-700" :
                "bg-sky-100 text-sky-700"
              }`}>
                {riskDialogLevel === "경고" && <AlertTriangle className="h-3.5 w-3.5" />}
                {riskDialogLevel}
              </span>
              어르신 명단
              <Badge variant="secondary" className="ml-1">
                {riskDialogLevel ? groups.filter((g) => getEffectiveRisk(g) === riskDialogLevel).length : 0}명
              </Badge>
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 max-h-[60dvh] overflow-y-auto pr-1">
            {riskDialogLevel && groups
              .filter((g) => getEffectiveRisk(g) === riskDialogLevel)
              .map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => {
                    setRiskDialogLevel(null);
                    handleSelectGroup(g);
                  }}
                  className="w-full flex items-center gap-3 rounded-md border border-border px-3 py-2.5 text-left hover:bg-accent transition-colors"
                >
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                    riskDialogLevel === "경고" ? "bg-red-100 text-red-700" :
                    riskDialogLevel === "주의" ? "bg-amber-100 text-amber-700" :
                    "bg-sky-100 text-sky-700"
                  }`}>
                    {(g.name ?? "?").charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-sm truncate">{g.name ?? "이름 미상"}</span>
                      {g.verified && (
                        <ShieldCheck className="h-3 w-3 text-primary shrink-0" />
                      )}
                    </div>
                    {g.keywords.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {g.keywords.slice(0, 4).map((k) => (
                          <span key={k} className={`text-[10px] rounded-full px-1.5 py-0 font-medium ${
                            riskDialogLevel === "경고" ? "bg-red-100 text-red-700" :
                            riskDialogLevel === "주의" ? "bg-amber-100 text-amber-700" :
                            "bg-sky-100 text-sky-700"
                          }`}>{k}</span>
                        ))}
                      </div>
                    )}
                    {g.last_user_message && (
                      <p className="text-[11px] text-muted-foreground truncate mt-0.5">{g.last_user_message}</p>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">{ago(g.last_active_at)}</span>
                </button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── 어르신 목록 아이템 (KakaoTalk 스타일) ────────
function SeniorListItem({
  g, effectiveRisk, selected, onClick,
}: {
  g: ClientGroup;
  effectiveRisk: RiskLevel;
  selected: boolean;
  onClick: () => void;
}) {
  const dotColor =
    effectiveRisk === "경고" ? "bg-red-500" :
    effectiveRisk === "주의" ? "bg-amber-400" :
    effectiveRisk === "점검" ? "bg-sky-400" : "";

  const avatarBg =
    effectiveRisk === "경고" ? "bg-red-100 text-red-700" :
    effectiveRisk === "주의" ? "bg-amber-100 text-amber-700" :
    effectiveRisk === "점검" ? "bg-sky-100 text-sky-700" :
    "bg-primary/10 text-primary";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent ${
        selected ? "bg-accent" : ""
      }`}
    >
      {/* 아바타 */}
      <div className="relative shrink-0">
        <div className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold ${avatarBg}`}>
          {(g.name ?? "?").charAt(0)}
        </div>
        {dotColor && (
          <span className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-card ${dotColor}`} />
        )}
      </div>

      {/* 이름 + 미리보기 */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {g.name ?? "이름 미상"}
          </p>
          <p className="shrink-0 text-[10px] text-muted-foreground">
            {ago(g.last_active_at)}
          </p>
        </div>
        <p className="truncate text-[11px] text-muted-foreground">
          {g.last_user_message ?? <span className="italic">대화 없음</span>}
        </p>
      </div>
    </button>
  );
}

// ── 서브컴포넌트들 ─────────────────────────────
function AnalysisCard({ a }: { a: CompanionAnalysis }) {
  const noRisk = !a.riskSignals?.trim() || /특이사항\s*없|없음|없습니다/.test(a.riskSignals);
  const block = (label: string, value: string, cls: string) =>
    value?.trim() ? (
      <div className={`rounded-md border p-2 ${cls}`}>
        <div className="text-[10px] font-semibold mb-0.5">{label}</div>
        <p className="text-xs whitespace-pre-wrap leading-relaxed">{value}</p>
      </div>
    ) : null;
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
        <Sparkles className="h-3.5 w-3.5" /> AI 분석 (제미나이)
      </div>
      {a.summary?.trim() && (
        <p className="text-xs whitespace-pre-wrap leading-relaxed text-muted-foreground">{a.summary}</p>
      )}
      <div className={`rounded-md border p-2 ${noRisk ? "border-border bg-background" : "border-red-300 bg-red-50"}`}>
        <div className={`flex items-center gap-1 text-[10px] font-semibold mb-0.5 ${noRisk ? "text-muted-foreground" : "text-red-700"}`}>
          <AlertTriangle className="h-3 w-3" /> 위험신호
        </div>
        <p className={`text-xs whitespace-pre-wrap leading-relaxed ${noRisk ? "" : "text-red-900"}`}>
          {a.riskSignals?.trim() || "특이사항 없음"}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {block("욕구", a.needs, "border-border bg-background")}
        {block("희망사항", a.wishes, "border-border bg-background")}
        {block("정서 상태", a.emotional, "border-border bg-background")}
        {block("담당자 제안", a.suggestion, "border-primary/30 bg-background")}
      </div>
    </div>
  );
}

function StatCard({ label, value, tone, onClick, active }: {
  label: string; value: number; tone: string;
  onClick?: () => void; active?: boolean;
}) {
  return (
    <button type="button" onClick={onClick}
      className={[
        "rounded-lg border p-2.5 text-left w-full transition-all",
        tone,
        onClick ? "cursor-pointer hover:brightness-95 active:scale-[0.98]" : "",
        active ? "ring-2 ring-offset-1 ring-current/40 shadow-sm" : "",
      ].join(" ")}>
      <div className="text-xl font-bold tabular-nums">{value}</div>
      <div className="text-[10px] opacity-80">{label}</div>
    </button>
  );
}

function RiskBadge({ risk }: { risk: RiskLevel }) {
  if (risk === "정상")
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-border text-muted-foreground">정상</Badge>
    );
  return (
    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${riskTone[risk]}`}>
      {risk === "경고" && <AlertTriangle className="h-3 w-3 mr-0.5" />}
      {risk}
    </Badge>
  );
}

function SetupNotice({ reason, joinCode, onRetry }: { reason: string; joinCode: string; onRetry: () => void }) {
  const isNotFound = reason === "RPC_NOT_FOUND";
  const isUnauth = reason === "unauthorized";
  const isNoOrg = reason === "no_org";
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 space-y-2">
      <div className="flex items-center gap-1.5 font-semibold">
        <AlertTriangle className="h-4 w-4" /> 복순이 모니터링 설정이 필요합니다
      </div>
      {isNoOrg ? <p>기관 정보가 없어 조회할 수 없습니다.</p> :
       isNotFound ? <p>복순이 DB에 조회 함수가 아직 적용되지 않았어요.</p> :
       isUnauth ? <p>공유 시크릿이 맞지 않습니다.</p> :
       <p>불러오기 실패: {reason}</p>}
      <p className="text-[11px] text-amber-800">현재 기관코드: {joinCode || "(없음)"}</p>
      <Button size="sm" variant="outline" onClick={onRetry} className="border-amber-400">
        <RefreshCw className="h-4 w-4" /> 다시 시도
      </Button>
    </div>
  );
}
