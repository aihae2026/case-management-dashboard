import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ActivityLog, Provision } from "@/lib/case-types";

type Props = { logs: ActivityLog[]; provisions: Provision[]; months?: number };

/** 최근 N개월의 월별 상담·제공 활동 건수 추이. 시계열 데이터는 기록의 실제 발생 시점에서 집계한다. */
export function ActivityTrendChart({ logs, provisions, months = 6 }: Props) {
  const data = useMemo(() => {
    const now = new Date();
    const buckets: { key: string; label: string; 상담: number; 제공: number }[] = [];
    const index: Record<string, number> = {};
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      index[key] = buckets.length;
      buckets.push({ key, label: `${d.getMonth() + 1}월`, 상담: 0, 제공: 0 });
    }
    const bump = (iso: string | null, field: "상담" | "제공") => {
      if (!iso) return;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const idx = index[key];
      if (idx != null) buckets[idx][field] += 1;
    };
    logs.forEach((l) => bump(l.created_at, "상담"));
    provisions.forEach((p) => bump(p.provided_at, "제공"));
    return buckets;
  }, [logs, provisions, months]);

  const hasData = data.some((d) => d.상담 > 0 || d.제공 > 0);

  if (!hasData) {
    return (
      <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">
        표시할 활동 기록이 아직 없습니다.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
        <defs>
          <linearGradient id="fillCounsel" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.5} />
            <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="fillProvide" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-2)" stopOpacity={0.5} />
            <stop offset="95%" stopColor="var(--chart-2)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} width={28} />
        <Tooltip
          contentStyle={{
            background: "var(--background)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Area
          type="monotone"
          dataKey="상담"
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="url(#fillCounsel)"
        />
        <Area
          type="monotone"
          dataKey="제공"
          stroke="var(--chart-2)"
          strokeWidth={2}
          fill="url(#fillProvide)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
