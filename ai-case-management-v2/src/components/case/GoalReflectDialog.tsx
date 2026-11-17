import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Link2, Loader2 } from "lucide-react";
import type { Client, Goal, ActivityLog, Provision, ReassessNeed } from "@/lib/case-types";
import {
  TARGET_PERIODS,
  type TargetPeriod,
  defaultTargetFor,
  needToGoalBody,
  withTargetLine,
  matchGoal,
  targetAchievement,
} from "@/lib/goal-linking";

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  needs: ReassessNeed[];
  client: Client;
  onDone: () => void;
};

type RowState = { period: TargetPeriod; count: number; action: string };

/**
 * 재사정 욕구를 서비스 목표로 반영하는 공용 다이얼로그.
 * - 담당자가 정량 목표량(기본 월 2회)을 확인·수정하고 확정한다.
 * - 기존 유사 목표가 있으면 비교 후 추가·수정·유지·종결을 선택.
 * - 달성률은 상담기록·제공이력과 목표량으로 자동 계산해 저장한다.
 */
export function GoalReflectDialog({ open, onOpenChange, needs, client, onDone }: Props) {
  const [existing, setExisting] = useState<Goal[]>([]);
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [provs, setProvs] = useState<Provision[]>([]);
  const [rows, setRows] = useState<Record<number, RowState>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    (async () => {
      const [g, l, p] = await Promise.all([
        supabase.from("goals").select("*").eq("client_id", client.id),
        supabase.from("activity_logs").select("*").eq("client_id", client.id),
        supabase.from("provisions").select("*").eq("client_id", client.id),
      ]);
      const goals = (g.data as Goal[]) ?? [];
      setExisting(goals);
      setLogs((l.data as ActivityLog[]) ?? []);
      setProvs((p.data as Provision[]) ?? []);
      const init: Record<number, RowState> = {};
      needs.forEach((n, i) => {
        const t = defaultTargetFor(n);
        init[i] = {
          period: t.period,
          count: t.count,
          action: matchGoal(n, goals) ? "수정" : "추가",
        };
      });
      setRows(init);
    })();
  }, [open, needs, client.id]);

  const setRow = (i: number, patch: Partial<RowState>) =>
    setRows((s) => ({ ...s, [i]: { ...s[i], ...patch } }));

  async function apply() {
    setBusy(true);
    type Ins = {
      org_id: string;
      client_id: string;
      kind: string;
      title: string;
      detail: string | null;
      progress: number;
      source: string;
    };
    const inserts: Ins[] = [];
    const updates: {
      id: string;
      patch: { title?: string; detail?: string | null; progress?: number };
    }[] = [];

    needs.forEach((n, i) => {
      const st = rows[i] ?? { period: "월" as TargetPeriod, count: 2, action: "추가" };
      if (st.action === "유지") return;
      const { title, body } = needToGoalBody(n);
      const detail = withTargetLine(st.period, st.count, body);
      const m = matchGoal(n, existing);
      if (st.action === "종결" && m) {
        updates.push({
          id: m.id,
          patch: { progress: 100, detail: (m.detail ? m.detail + "\n" : "") + "[재사정: 종결]" },
        });
        return;
      }
      // 신규/수정: 목표량 대비 달성률을 상담·제공 기록으로 즉시 계산
      const progress =
        targetAchievement({ title, detail, created_at: m?.created_at }, logs, provs) ?? 0;
      if (st.action === "수정" && m) {
        updates.push({ id: m.id, patch: { title, detail, progress } });
      } else {
        inserts.push({
          org_id: client.org_id,
          client_id: client.id,
          kind: "서비스",
          title,
          detail,
          progress,
          source: "재사정",
        });
      }
    });

    try {
      if (inserts.length) {
        const { error } = await supabase.from("goals").insert(inserts);
        if (error) throw error;
      }
      for (const u of updates) {
        const { error } = await supabase.from("goals").update(u.patch).eq("id", u.id);
        if (error) throw error;
      }
      // 평균 달성률을 client.progress에 반영 → 전체 현황 연동
      const { data: after } = await supabase
        .from("goals")
        .select("progress")
        .eq("client_id", client.id);
      const arr = (after as { progress: number }[]) ?? [];
      const avg = arr.length ? Math.round(arr.reduce((s, x) => s + x.progress, 0) / arr.length) : 0;
      const { data: updated } = await supabase
        .from("clients")
        .update({ progress: avg })
        .eq("id", client.id)
        .eq("updated_at", client.updated_at)
        .select("id");
      if (!updated || updated.length === 0) {
        throw new Error("다른 담당자가 방금 수정했습니다. 새로고침 후 다시 시도해주세요.");
      }

      toast.success(`서비스 목표 반영: 추가 ${inserts.length}건 · 수정/종결 ${updates.length}건`);
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast.error("반영 실패: " + (e as Error).message);
    }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Link2 className="h-4 w-4 text-primary" /> 서비스 목표 반영 (확인·확정)
          </DialogTitle>
          <DialogDescription>
            각 욕구를 서비스 목표로 반영합니다. 정량 목표량(기본 월 2회)을 확인·수정한 뒤
            확정하세요. 달성률은 상담기록·제공이력으로 자동 점검됩니다.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          {needs.map((n, i) => {
            const st = rows[i];
            const m = matchGoal(n, existing);
            const { title, body } = needToGoalBody(n);
            return (
              <div key={i} className="rounded-md border border-border p-2.5 space-y-2">
                <div className="text-sm font-medium">{title}</div>
                {body && (
                  <div className="text-xs text-muted-foreground whitespace-pre-wrap">{body}</div>
                )}

                {/* 정량 목표량 */}
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">정량 목표량</span>
                  <div className="w-20">
                    <Select
                      value={st?.period}
                      onValueChange={(v) => setRow(i, { period: v as TargetPeriod })}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TARGET_PERIODS.map((p) => (
                          <SelectItem key={p} value={p}>
                            {p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Input
                    type="number"
                    min={1}
                    value={st?.count ?? 2}
                    onChange={(e) => setRow(i, { count: Math.max(1, Number(e.target.value) || 1) })}
                    className="h-8 w-16"
                  />
                  <span className="text-muted-foreground">회</span>
                  {m && (
                    <Badge variant="outline" className="ml-1 text-[10px]">
                      기존 목표 있음 · 현재 {m.progress}%
                    </Badge>
                  )}
                </div>

                {/* 처리 방식 */}
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">처리</span>
                  <div className="w-28">
                    <Select value={st?.action} onValueChange={(v) => setRow(i, { action: v })}>
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(m ? ["수정", "유지", "종결", "추가"] : ["추가", "유지"]).map((a) => (
                          <SelectItem key={a} value={a}>
                            {a}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <span className="text-muted-foreground">
                    {m ? "기존 목표와 비교해 처리 방식을 선택하세요." : "신규 목표로 추가됩니다."}
                  </span>
                </div>
              </div>
            );
          })}
          {needs.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              반영할 욕구가 없습니다.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button onClick={apply} disabled={busy || needs.length === 0}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} 목표 확정
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
