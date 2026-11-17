import { ClientName } from "@/components/NameMask";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Package } from "lucide-react";
import { PROVISION_CATEGORIES, type Client } from "@/lib/case-types";
import { AGENCY_PRESETS } from "./counsel-utils";

// ── 사례관리 일괄 제공 기록 다이얼로그 ──────────────────────────────────
export function BulkCaseDialog({
  open,
  onOpenChange,
  clients,
  orgId,
  workerName,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  clients: Client[];
  orgId: string;
  workerName: string;
  onSaved: () => Promise<void>;
}) {
  const today = new Date().toLocaleDateString("en-CA");
  const [date, setDate] = useState(today);
  const [category, setCategory] = useState<string>(PROVISION_CATEGORIES[0]);
  const [title, setTitle] = useState("");
  const [quantity, setQuantity] = useState("");
  const [agency, setAgency] = useState("");
  const [agencyPreset, setAgencyPreset] = useState("");
  const [memo, setMemo] = useState("");
  // clientId → 미제공 사유 (has(id) = 미제공)
  const [excluded, setExcluded] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);

  function toggleExclude(id: string) {
    setExcluded((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, "");
      return next;
    });
  }
  function setReason(id: string, reason: string) {
    setExcluded((prev) => new Map(prev).set(id, reason));
  }

  async function save() {
    if (!title.trim()) return toast.error("항목을 입력해주세요.");
    if (!date) return toast.error("제공일을 선택해주세요.");
    setBusy(true);
    try {
      const receivedClients = clients.filter((c) => !excluded.has(c.id));
      const excludedClients = clients.filter((c) => excluded.has(c.id));

      if (receivedClients.length > 0) {
        const provRows = receivedClients.map((c) => ({
          client_id: c.id,
          org_id: orgId,
          category,
          title: title.trim(),
          quantity: quantity.trim() || null,
          agency: agency.trim() || null,
          note: memo.trim() || null,
          provided_at: date,
        }));
        const { error } = await supabase.from("provisions").insert(provRows);
        if (error) throw error;
      }

      if (excludedClients.length > 0) {
        const logRows = excludedClients.map((c) => {
          const reason = excluded.get(c.id);
          return {
            client_id: c.id,
            org_id: orgId,
            method: "방문",
            note: `미제공 (${title.trim()})${reason ? ` — ${reason}` : ""}`,
            worker_name: workerName || null,
            created_at: new Date(date + "T12:00:00+09:00").toISOString(),
          };
        });
        const { error } = await supabase.from("activity_logs").insert(logRows);
        if (error) throw error;
      }

      toast.success(
        `일괄 제공 기록 완료 — 제공 ${receivedClients.length}명, 미제공 ${excludedClients.length}명`,
      );
      onOpenChange(false);
      await onSaved();
    } catch (e) {
      toast.error("저장 실패: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90dvh] flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-4 w-4" />
            사례관리 일괄 제공 기록
          </DialogTitle>
          <DialogDescription>
            제공받은 분은 제공이력으로, 미제공은 상담기록으로 저장됩니다.
          </DialogDescription>
        </DialogHeader>

        {/* 제공이력 공통 정보 */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="space-y-1">
              <label htmlFor="bulk-case-date" className="text-xs text-muted-foreground">제공일</label>
              <input
                id="bulk-case-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">분류</label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVISION_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 col-span-2">
              <label htmlFor="bulk-case-title" className="text-xs text-muted-foreground">
                항목 <span className="text-destructive">*</span>
              </label>
              <Input
                id="bulk-case-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: 생필품 지원, 도시락 배달"
                className="h-8"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <label htmlFor="bulk-case-qty" className="text-xs text-muted-foreground">수량/횟수</label>
              <Input id="bulk-case-qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="예: 1회" className="h-8" />
            </div>
            <div className="space-y-1">
              <label htmlFor="bulk-case-agency" className="text-xs text-muted-foreground">제공기관</label>
              <Select value={agencyPreset} onValueChange={(val) => {
                setAgencyPreset(val);
                if (val !== "직접입력") setAgency(val);
                else setAgency("");
              }}>
                <SelectTrigger id="bulk-case-agency" className="h-8 text-xs">
                  <SelectValue placeholder="선택 또는 직접입력" />
                </SelectTrigger>
                <SelectContent>
                  {AGENCY_PRESETS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                  <SelectItem value="직접입력">직접입력</SelectItem>
                </SelectContent>
              </Select>
              {agencyPreset === "직접입력" && (
                <Input value={agency} onChange={(e) => setAgency(e.target.value)} placeholder="기관명 입력" className="h-8 mt-1" />
              )}
            </div>
            <div className="space-y-1">
              <label htmlFor="bulk-case-memo" className="text-xs text-muted-foreground">비고</label>
              <Input id="bulk-case-memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="메모" className="h-8" />
            </div>
          </div>
        </div>

        {/* 대상자 목록 */}
        <div className="flex-1 overflow-y-auto space-y-1.5 min-h-0 border border-border rounded-md p-2">
          {clients.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              사례관리 대상자가 없습니다.
            </p>
          ) : (
            clients.map((c) => {
              const isExcluded = excluded.has(c.id);
              return (
                <div
                  key={c.id}
                  className={`rounded-md border px-3 py-2 transition-colors ${
                    isExcluded
                      ? "border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700"
                      : "border-border bg-card"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`case-excl-${c.id}`}
                      checked={isExcluded}
                      onChange={() => toggleExclude(c.id)}
                      className="h-4 w-4 shrink-0 accent-amber-500"
                    />
                    <label htmlFor={`case-excl-${c.id}`} className="flex-1 text-sm font-medium cursor-pointer select-none">
                      <ClientName c={c} />
                    </label>
                    <span className="text-[11px] text-muted-foreground">{c.worker_name ?? "미배정"}</span>
                    {isExcluded ? (
                      <span className="text-[11px] text-amber-600 font-medium">미제공</span>
                    ) : (
                      <span className="text-[11px] text-emerald-600 font-medium">제공</span>
                    )}
                  </div>
                  {isExcluded && (
                    <Input
                      value={excluded.get(c.id) ?? ""}
                      onChange={(e) => setReason(c.id, e.target.value)}
                      placeholder="미제공 사유 (예: 입원, 외출 등)"
                      className="mt-2 h-8 text-xs"
                    />
                  )}
                </div>
              );
            })
          )}
        </div>

        <p className="text-xs text-muted-foreground text-right">
          제공 {clients.length - excluded.size}명 · 미제공 {excluded.size}명
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            취소
          </Button>
          <Button onClick={save} disabled={busy || clients.length === 0 || !title.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Package className="h-4 w-4" />}
            일괄 저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
