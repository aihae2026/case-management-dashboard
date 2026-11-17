import { useNameMask, maskedName } from "@/lib/name-mask-context";
import { toKstDate } from "@/lib/log-time";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Loader2, Trash2 } from "lucide-react";
import {
  programsOf,
  type Client,
  type ActivityLog,
  type Provision,
} from "@/lib/case-types";
import { DAY_LABELS, METHOD_COLORS } from "./counsel-utils";
import { CounselPatternCard } from "./CounselPatternCard";
import { getKoreanDayInfoMap } from "@/lib/korean-seasons";

// ── 상담기록 달력 뷰 (대상자 미선택 시) ────────────────────
export function CounselListView({
  clients,
  logs,
  provisions,
  onSelectClient,
  onSelectProvision,
  onChanged,
}: {
  clients: Client[];
  logs: ActivityLog[];
  provisions: Provision[];
  onSelectClient: (id: string) => void;
  onSelectProvision: (id: string) => void;
  onChanged: () => void;
}) {
  const today = new Date();
  const { hidden } = useNameMask();
  const [calYear, setCalYear] = useState(today.getFullYear());
  const [calMonth, setCalMonth] = useState(today.getMonth()); // 0-indexed
  const [methodFilter, setMethodFilter] = useState("전체");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  // 제공이력 칩은 사업단(프로그램)별로 묶어 "날짜::사업단" 단위로 펼친다
  const [expandedProv, setExpandedProv] = useState<Set<string>>(new Set());
  // 달력에서 이름 칩을 누르면 그 대상자만 아래 상세에 보여 준다(null 이면 그날 전체)
  const [focusClientId, setFocusClientId] = useState<string | null>(null);
  const [deletingProvId, setDeletingProvId] = useState<string | null>(null);

  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);

  async function deleteProvision(id: string) {
    if (!confirm("이 제공이력을 삭제하시겠습니까?")) return;
    setDeletingProvId(id);
    const { error } = await supabase.from("provisions").delete().eq("id", id);
    setDeletingProvId(null);
    if (error) { toast.error(error.message); return; }
    toast.success("삭제됐습니다.");
    onChanged();
  }

  const METHODS = ["전화", "방문", "문자", "내방"];

  // 사업/담당자 범위로 걸러진 로그 (달력 방법필터 제외) — 상담 패턴 카드에 전달
  const scopedLogs = useMemo(
    () => logs.filter((l) => clientById.has(l.client_id)),
    [logs, clients], // clients가 바뀌면 clientById도 갱신
  );

  // 필터링된 로그 (접촉방법 필터 추가 적용) — 달력 표시에 사용
  const filtered = useMemo(
    () =>
      scopedLogs.filter((l) => {
        if (methodFilter !== "전체" && l.method !== methodFilter) return false;
        return true;
      }),
    [scopedLogs, methodFilter],
  );

  // 날짜별 그룹핑
  const byDate = useMemo(() => {
    const map = new Map<string, ActivityLog[]>();
    for (const l of filtered) {
      const d = toKstDate(l.created_at);
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(l);
    }
    return map;
  }, [filtered]);

  const todayDateStr = new Date().toLocaleDateString("en-CA");

  // 날짜별 제공이력 그룹핑
  const provByDate = useMemo(() => {
    const map = new Map<string, Provision[]>();
    for (const p of provisions) {
      if (!clientById.has(p.client_id)) continue;
      const d = p.provided_at.slice(0, 10);
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(p);
    }
    return map;
  }, [provisions, clientById]);

  // 달력 그리드 생성
  const weeks = useMemo(() => {
    const firstDay = new Date(calYear, calMonth, 1).getDay(); // 0=일
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const cells: (number | null)[] = [
      ...Array(firstDay).fill(null),
      ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
    ];
    // 7의 배수로 채우기
    while (cells.length % 7 !== 0) cells.push(null);
    const result: (number | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) result.push(cells.slice(i, i + 7));
    return result;
  }, [calYear, calMonth]);

  const prevMonth = () => {
    setExpandedDate(null); setExpandedProv(new Set());
    if (calMonth === 0) { setCalYear(y => y - 1); setCalMonth(11); }
    else setCalMonth(m => m - 1);
    setSelectedDate(null);
  };
  const nextMonth = () => {
    setExpandedDate(null); setExpandedProv(new Set());
    if (calMonth === 11) { setCalYear(y => y + 1); setCalMonth(0); }
    else setCalMonth(m => m + 1);
    setSelectedDate(null);
  };

  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  // 공휴일·절기 정보 (연도 단위 캐시)
  const dayInfoMap = useMemo(() => getKoreanDayInfoMap(calYear), [calYear]);

  // 현재 보이는 달의 상담기록·제공이력 건수
  const monthPrefix = `${calYear}-${String(calMonth + 1).padStart(2, "0")}`;
  const monthLogsCount = useMemo(
    () => scopedLogs.filter((l) => toKstDate(l.created_at).startsWith(monthPrefix)).length,
    [scopedLogs, monthPrefix],
  );
  const monthProvsCount = useMemo(() => {
    let count = 0;
    provByDate.forEach((ps, d) => { if (d.startsWith(monthPrefix)) count += ps.length; });
    return count;
  }, [provByDate, monthPrefix]);

  const selectedLogsAll = selectedDate ? (byDate.get(selectedDate) ?? []) : [];
  // 이름 칩으로 한 명을 골랐으면 그 대상자의 기록만 보여 준다
  const selectedLogs = focusClientId ? selectedLogsAll.filter((l) => l.client_id === focusClientId) : selectedLogsAll;
  const selectedProvs = selectedDate
    ? (provByDate.get(selectedDate) ?? []).filter((p) => !focusClientId || p.client_id === focusClientId)
    : [];

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* 헤더: 월 이동 + 필터 */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border">
        {/* 월 네비게이션 */}
        <div className="flex items-center gap-2">
          <button
            onClick={prevMonth}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent transition-colors text-muted-foreground"
          >
            ‹
          </button>
          <span className="text-sm font-semibold min-w-[7rem] text-center">
            {calYear}년 {calMonth + 1}월
          </span>
          <button
            onClick={nextMonth}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent transition-colors text-muted-foreground"
          >
            ›
          </button>
          <button
            onClick={() => { setCalYear(today.getFullYear()); setCalMonth(today.getMonth()); setSelectedDate(null); setExpandedDate(null); setExpandedProv(new Set()); }}
            className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded border border-border hover:bg-accent transition-colors"
          >
            오늘
          </button>
          <span className="text-xs text-muted-foreground select-none">
            상담 <span className="font-semibold text-foreground">{monthLogsCount}</span>건
            {" · "}
            제공 <span className="font-semibold text-foreground">{monthProvsCount}</span>건
          </span>
        </div>

        {/* 접촉방법 필터 */}
        <div className="flex flex-wrap gap-1 ml-auto">
          {["전체", ...METHODS].map((m) => (
            <button
              key={m}
              onClick={() => setMethodFilter(m)}
              className={`px-2.5 py-0.5 rounded-full text-xs border transition-colors ${
                methodFilter === m
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:bg-accent"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* 달력 그리드 */}
      <div className="overflow-x-auto">
        <div className="min-w-[480px]">
          {/* 요일 헤더 */}
          <div className="grid grid-cols-7 border-b border-border">
            {DAY_LABELS.map((d, i) => (
              <div
                key={d}
                className={`py-1.5 text-center text-xs font-medium ${
                  i === 0 ? "text-red-500" : i === 6 ? "text-blue-500" : "text-muted-foreground"
                }`}
              >
                {d}
              </div>
            ))}
          </div>

          {/* 주 행 */}
          {weeks.map((week, wi) => (
            <div key={wi} className="grid grid-cols-7 border-b border-border last:border-0">
              {week.map((day, di) => {
                if (day === null) {
                  return <div key={di} className="min-h-[80px] bg-muted/20 border-r border-border last:border-0" />;
                }
                const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                const dayLogs = byDate.get(dateStr) ?? [];
                const isToday = dateStr === todayStr;
                const isSelected = dateStr === selectedDate;
                const isSun = di === 0;
                const isSat = di === 6;
                const dayInfo = dayInfoMap.get(dateStr);
                const isHoliday = dayInfo?.isHoliday;

                return (
                  <div
                    key={di}
                    onClick={() => { setSelectedDate(isSelected && !focusClientId ? null : dateStr); setFocusClientId(null); }}
                    className={`min-h-[80px] border-r border-border last:border-0 p-1 cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-primary/10"
                        : dayLogs.length > 0
                        ? "hover:bg-accent/50"
                        : "hover:bg-accent/20"
                    }`}
                  >
                    {/* 날짜 숫자 + 공휴일명/절기명 */}
                    <div className="flex flex-col items-end mb-1">
                      <span
                        className={`text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full ${
                          isToday
                            ? "bg-primary text-primary-foreground"
                            : isHoliday || isSun
                            ? "text-red-500"
                            : isSat
                            ? "text-blue-500"
                            : "text-foreground"
                        }`}
                      >
                        {day}
                      </span>
                      {dayInfo?.holiday && (
                        <span className="text-[9px] leading-tight text-red-500 text-right max-w-full truncate" title={dayInfo.holiday}>
                          {dayInfo.holiday}
                        </span>
                      )}
                      {dayInfo?.season && (
                        <span className="text-[9px] leading-tight text-emerald-600 dark:text-emerald-400 text-right max-w-full truncate" title={dayInfo.season}>
                          {dayInfo.season}
                        </span>
                      )}
                    </div>

                    {/* 상담 기록 pills */}
                    {(() => {
                      const isExpanded = expandedDate === dateStr;
                      const visibleLogs = isExpanded ? dayLogs : dayLogs.slice(0, 3);
                      const hiddenCount = dayLogs.length - 3;
                      return (
                        <div className="flex flex-col gap-0.5">
                          {visibleLogs.map((l) => {
                            const c = clientById.get(l.client_id);
                            const colorCls = METHOD_COLORS[l.method] ?? "bg-muted text-muted-foreground";
                            return (
                              <button
                                key={l.id}
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setSelectedDate(dateStr); setFocusClientId(l.client_id); }}
                                className={`rounded px-1 py-0.5 text-[10px] leading-tight truncate text-left w-full hover:brightness-95 cursor-pointer ${colorCls}`}
                                title={`${maskedName(c, hidden)} · ${l.method} · ${l.note?.slice(0, 40)} · 클릭해서 이 분만 보기`}
                              >
                                {maskedName(c, hidden, "?")}
                                {l.method && <span className="opacity-70 ml-0.5">({l.method})</span>}
                              </button>
                            );
                          })}
                          {!isExpanded && hiddenCount > 0 && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedDate(dateStr);
                              }}
                              className="text-[10px] text-primary pl-1 text-left hover:underline"
                            >
                              +{hiddenCount}건 더
                            </button>
                          )}
                          {isExpanded && dayLogs.length > 3 && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedDate(null);
                              }}
                              className="text-[10px] text-muted-foreground pl-1 text-left hover:underline"
                            >
                              접기 ▲
                            </button>
                          )}
                        </div>
                      );
                    })()}
                    {/* 제공이력 pills — 사업단별로 묶어 접어 두고, 누른 사업단만 개별 이름으로 펼침 */}
                    {(() => {
                      const dayProvs = provByDate.get(dateStr) ?? [];
                      if (dayProvs.length === 0) return null;
                      const isFutureDay = dateStr > todayDateStr;
                      const colorCls = isFutureDay
                        ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                        : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300";
                      const suffix = isFutureDay ? "(예정)" : "(제공)";
                      // 이름을 누르면 날짜를 열고 그 대상자만 상세에 보여 준다
                      const focusOn = (e: { stopPropagation: () => void }, clientId: string) => {
                        e.stopPropagation();
                        setSelectedDate(dateStr);
                        setFocusClientId(clientId);
                      };

                      const programGroups = new Map<string, { clientId: string; name: string; provTitle: string }[]>();
                      for (const p of dayProvs) {
                        const pc = clientById.get(p.client_id);
                        const progs = pc ? programsOf(pc) : [];
                        const groupKey = progs.length > 0 ? progs[0] : "기타";
                        if (!programGroups.has(groupKey)) programGroups.set(groupKey, []);
                        programGroups.get(groupKey)!.push({ clientId: p.client_id, name: maskedName(pc, hidden, "?"), provTitle: p.title });
                      }
                      return (
                        <div className="flex flex-col gap-0.5 mt-0.5">
                          {[...programGroups.entries()].map(([prog, items]) => {
                            const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name, "ko"));
                            const groupKey = `${dateStr}::${prog}`;

                            // 한 명뿐인 사업단은 펼칠 것이 없으므로 그 대상자만 상세에 보여 준다
                            if (sorted.length === 1) {
                              return (
                                <button
                                  key={prog}
                                  type="button"
                                  onClick={(e) => focusOn(e, sorted[0].clientId)}
                                  className={`rounded px-1 py-0.5 text-[10px] leading-tight truncate text-left w-full hover:brightness-95 cursor-pointer ${colorCls}`}
                                  title={`[${prog}] ${sorted[0].name} · ${sorted[0].provTitle} · 클릭해서 이 분만 보기`}
                                >
                                  {sorted[0].name}
                                  <span className="opacity-70 ml-0.5">{suffix}</span>
                                </button>
                              );
                            }

                            if (expandedProv.has(groupKey)) {
                              return (
                                <div key={prog} className="flex flex-col gap-0.5">
                                  {sorted.map((item, i) => (
                                    <button
                                      key={`${prog}-${item.clientId}-${i}`}
                                      type="button"
                                      onClick={(e) => focusOn(e, item.clientId)}
                                      className={`rounded px-1 py-0.5 text-[10px] leading-tight truncate text-left w-full hover:brightness-95 cursor-pointer ${colorCls}`}
                                      title={`[${prog}] ${item.name} · ${item.provTitle} · 클릭해서 이 분만 보기`}
                                    >
                                      {item.name}
                                      <span className="opacity-70 ml-0.5">{suffix}</span>
                                    </button>
                                  ))}
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setExpandedProv((prev) => {
                                        const next = new Set(prev);
                                        next.delete(groupKey);
                                        return next;
                                      });
                                    }}
                                    className="text-[10px] text-muted-foreground pl-1 text-left hover:underline"
                                  >
                                    접기 ▲
                                  </button>
                                </div>
                              );
                            }

                            const allNames = sorted.map((i) => i.name).join(", ");
                            return (
                              <button
                                key={prog}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedProv((prev) => new Set(prev).add(groupKey));
                                }}
                                className={`rounded px-1 py-0.5 text-[10px] leading-tight truncate text-left w-full hover:brightness-95 cursor-pointer ${colorCls}`}
                                title={`[${prog}] ${allNames}${isFutureDay ? " (예정)" : ""} · 클릭해서 펼치기`}
                              >
                                {sorted[0].name} 외 {sorted.length - 1}명
                                <span className="opacity-70 ml-0.5">{suffix}</span>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* 선택된 날짜 상세 패널 */}
      {selectedDate && (
        <div className="border-t border-border bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2 mb-3">
            <span className="font-medium text-sm">
              {new Date(selectedDate + "T00:00:00").toLocaleDateString("ko-KR", {
                year: "numeric", month: "long", day: "numeric", weekday: "short",
              })}
            </span>
            <Badge variant="secondary" className="text-[10px]">{selectedLogs.length}건</Badge>
            {selectedProvs.length > 0 && (
              <Badge variant="secondary" className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                제공 {selectedProvs.length}건
              </Badge>
            )}
            {focusClientId && (
              <button
                type="button"
                onClick={() => setFocusClientId(null)}
                className="text-[11px] text-primary hover:underline"
                title="그날 전체 보기"
              >
                {maskedName(clientById.get(focusClientId), hidden, "?")}님만 보는 중 · 전체 보기
              </button>
            )}
            <button
              onClick={() => { setSelectedDate(null); setFocusClientId(null); }}
              className="ml-auto text-muted-foreground hover:text-foreground text-lg leading-none"
            >
              ×
            </button>
          </div>

          {selectedLogs.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">{focusClientId ? "이 날짜에 이 분의 상담기록이 없습니다." : "이 날짜에 상담기록이 없습니다."}</p>
          ) : (
            <div className="flex flex-col gap-2 max-h-[40dvh] overflow-y-auto pr-1">
              {[...selectedLogs]
                .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                .map((l) => {
                  const c = clientById.get(l.client_id);
                  const colorCls = METHOD_COLORS[l.method] ?? "bg-muted text-muted-foreground";
                  return (
                    <div
                      key={l.id}
                      className="rounded-lg border border-border bg-card p-3 cursor-pointer hover:bg-accent/30 transition-colors"
                      onClick={() => onSelectClient(l.client_id)}
                      title={`${maskedName(c, hidden)}의 상담 화면 열기`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm">{maskedName(c, hidden, "?")}</span>
                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${colorCls}`}>
                          {l.method}
                        </span>
                        {l.worker_name && (
                          <span className="text-[10px] text-muted-foreground ml-auto">
                            {l.worker_name}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-3">
                        {l.note || "(내용 없음)"}
                      </p>
                    </div>
                  );
                })}
            </div>
          )}
          {/* 선택 날짜 제공이력 */}
          {(() => {
            const dayProvs = selectedProvs;
            if (dayProvs.length === 0) return null;
            return (
              <div className="mt-3 pt-3 border-t border-border">
                <p className="text-xs font-medium text-muted-foreground mb-2">제공이력 {dayProvs.length}건</p>
                <div className="flex flex-col gap-2 max-h-[20dvh] overflow-y-auto pr-1">
                  {dayProvs.map((p) => {
                    const pc = clientById.get(p.client_id);
                    return (
                      <div
                        key={p.id}
                        className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-800 p-3 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="font-medium text-sm cursor-pointer hover:underline"
                            onClick={() => onSelectProvision(p.client_id)}
                            title={`${maskedName(pc, hidden)}의 제공이력 보기`}
                          >
                            {maskedName(pc, hidden, "?")}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">제공</span>
                          <span className="text-xs text-muted-foreground">{p.agency ?? "자체"}</span>
                          <button
                            type="button"
                            onClick={() => deleteProvision(p.id)}
                            disabled={deletingProvId === p.id}
                            className="ml-auto text-muted-foreground hover:text-destructive disabled:opacity-40 transition-colors p-0.5 shrink-0"
                            title="삭제"
                          >
                            {deletingProvId === p.id
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Trash2 className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {p.title}{p.quantity ? ` · ${p.quantity}` : ""}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* 상담 패턴 — scopedLogs: 현재 사업/담당자 필터가 적용된 로그 */}
      <CounselPatternCard logs={scopedLogs} />
    </div>
  );
}
