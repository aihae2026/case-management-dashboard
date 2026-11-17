import { useMemo, useState } from "react";
import { type ActivityLog } from "@/lib/case-types";
import { normMethod, DAY_LABELS } from "./counsel-utils";

const METHODS_ORDER = ["전화", "방문", "문자", "내방"];
const METHOD_BAR_COLOR: Record<string, string> = {
  전화: "bg-blue-400",
  방문: "bg-green-400",
  문자: "bg-violet-400",
  내방: "bg-pink-400",
};

// ── 상담 패턴 시각화 ────────────────────────────────────────
export function CounselPatternCard({ logs }: { logs: ActivityLog[] }) {
  // 연도 목록 추출
  const years = useMemo(() => {
    const ySet = new Set<string>();
    logs.forEach((l) => {
      const y = new Date(l.created_at).getFullYear().toString();
      ySet.add(y);
    });
    return ["전체", ...Array.from(ySet).sort((a, b) => b.localeCompare(a))];
  }, [logs]);

  const [selectedYear, setSelectedYear] = useState<string>(new Date().getFullYear().toString());

  // 선택 연도에 따라 필터링
  const filteredLogs = useMemo(() => {
    if (selectedYear === "전체") return logs;
    return logs.filter((l) => new Date(l.created_at).getFullYear().toString() === selectedYear);
  }, [logs, selectedYear]);

  const pattern = useMemo(() => {
    // 방법별
    const methodAcc: Record<string, number> = {};
    METHODS_ORDER.forEach((m) => { methodAcc[m] = 0; });
    // 요일별
    const dayAcc: number[] = Array(7).fill(0);
    // 담당자별
    const workerAcc: Record<string, number> = {};

    filteredLogs.forEach((l) => {
      const m = normMethod(l.method);
      if (m && METHODS_ORDER.includes(m)) methodAcc[m] = (methodAcc[m] ?? 0) + 1;
      const d = new Date(l.created_at).getDay();
      dayAcc[d] += 1;
      const w = l.worker_name ?? "미배정";
      workerAcc[w] = (workerAcc[w] ?? 0) + 1;
    });

    const total = filteredLogs.length;
    const methods = METHODS_ORDER
      .map((m) => ({ label: m, count: methodAcc[m] ?? 0 }))
      .filter((x) => x.count > 0);
    const days = DAY_LABELS.map((d, i) => ({ label: d, count: dayAcc[i] }));
    const workers = Object.entries(workerAcc)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    const maxDay = Math.max(...dayAcc, 1);
    const maxWorker = workers[0]?.count ?? 1;
    return { total, methods, days, workers, maxDay, maxWorker };
  }, [filteredLogs]);

  if (logs.length === 0) return null;

  return (
    <div className="mt-4 rounded-lg border border-border p-3 bg-card space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground">
          상담 패턴 — {selectedYear === "전체" ? "전체" : selectedYear + "년"} {pattern.total}건
        </p>
        {years.length > 2 && (
          <select
            value={selectedYear}
            onChange={(e) => setSelectedYear(e.target.value)}
            className="text-xs border border-border rounded px-2 py-0.5 bg-background text-foreground"
          >
            {years.map((y) => (
              <option key={y} value={y}>{y === "전체" ? "전체 연도" : y + "년"}</option>
            ))}
          </select>
        )}
      </div>

      {/* 방법별 */}
      <div>
        <p className="text-[11px] text-muted-foreground mb-1.5">방법별</p>
        <div className="space-y-1.5">
          {pattern.methods.map(({ label, count }) => (
            <div key={label} className="flex items-center gap-2 text-xs">
              <span className="w-6 text-right shrink-0 text-muted-foreground">{label}</span>
              <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                <div
                  className={`h-2 rounded-full ${METHOD_BAR_COLOR[label] ?? "bg-primary"}`}
                  style={{ width: `${Math.round((count / pattern.total) * 100)}%` }}
                />
              </div>
              <span className="tabular-nums w-10 text-right shrink-0">
                {count}건 · {Math.round((count / pattern.total) * 100)}%
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 요일별 */}
      <div>
        <p className="text-[11px] text-muted-foreground mb-1.5">요일별</p>
        <div className="flex items-end gap-1 h-12">
          {pattern.days.map(({ label, count }) => (
            <div key={label} className="flex-1 flex flex-col items-center gap-0.5">
              <div
                className="w-full rounded-t bg-primary/70"
                style={{ height: `${Math.round((count / pattern.maxDay) * 44)}px`, minHeight: count > 0 ? 2 : 0 }}
              />
              <span className="text-[10px] text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 담당자별 */}
      {pattern.workers.length > 1 && (
        <div>
          <p className="text-[11px] text-muted-foreground mb-1.5">담당자별 (상위 5명)</p>
          <div className="space-y-1.5">
            {pattern.workers.map(({ name, count }) => (
              <div key={name} className="flex items-center gap-2 text-xs">
                <span className="w-14 truncate shrink-0 text-muted-foreground">{name}</span>
                <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                  <div
                    className="h-2 rounded-full bg-indigo-400"
                    style={{ width: `${Math.round((count / pattern.maxWorker) * 100)}%` }}
                  />
                </div>
                <span className="tabular-nums w-8 text-right shrink-0">{count}건</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
