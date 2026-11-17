import { ClientName } from "@/components/NameMask";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Loader2, Trash2 } from "lucide-react";
import {
  PROVISION_CATEGORIES,
  categoryColor,
  type Client,
  type Provision,
} from "@/lib/case-types";

// ── 제공이력 전체 목록 (대상자 미선택 시) ────────────────────
export function ProvisionListView({
  clients,
  provisions,
  onSelectClient,
  onChanged,
}: {
  clients: Client[];
  provisions: Provision[];
  onSelectClient: (id: string) => void;
  onChanged: () => void;
}) {
  const [catFilter, setCatFilter] = useState("전체");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const todayStr = new Date().toLocaleDateString("en-CA");

  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);

  const filtered = provisions
    .filter((p) => {
      if (!clientById.has(p.client_id)) return false;
      if (catFilter !== "전체" && p.category !== catFilter) return false;
      if (fromDate && p.provided_at < fromDate) return false;
      if (toDate && p.provided_at > toDate) return false;
      return true;
    })
    .sort((a, b) => {
      const dateComp = b.provided_at.localeCompare(a.provided_at);
      if (dateComp !== 0) return dateComp;
      // 같은 날짜: 대상자명 가나다순 → 같은 사람 기록이 연속으로 붙음
      const nameA = clientById.get(a.client_id)?.name ?? "";
      const nameB = clientById.get(b.client_id)?.name ?? "";
      return nameA.localeCompare(nameB, "ko");
    });

  const allChecked = filtered.length > 0 && filtered.every((p) => selectedIds.has(p.id));

  function toggleAll() {
    if (allChecked) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((p) => p.id)));
    }
  }

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function deleteSelected() {
    if (selectedIds.size === 0) return;
    if (!confirm(`선택한 제공이력 ${selectedIds.size}건을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;
    setDeleting(true);
    const { error } = await supabase.from("provisions").delete().in("id", [...selectedIds]);
    setDeleting(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`${selectedIds.size}건이 삭제됐습니다.`);
    setSelectedIds(new Set());
    onChanged();
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      {/* 필터 바 */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border">
        <span className="text-xs text-muted-foreground shrink-0">분류</span>
        <div className="flex flex-wrap gap-1">
          {["전체", ...PROVISION_CATEGORIES].map((c) => (
            <button
              key={c}
              onClick={() => { setCatFilter(c); setSelectedIds(new Set()); }}
              className={`px-2.5 py-0.5 rounded-full text-xs border transition-colors ${
                catFilter === c
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:bg-accent"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          <input
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => { setFromDate(e.target.value); setSelectedIds(new Set()); }}
            className="h-7 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <span className="text-muted-foreground text-xs">~</span>
          <input
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => { setToDate(e.target.value); setSelectedIds(new Set()); }}
            className="h-7 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {(fromDate || toDate) && (
            <button
              onClick={() => { setFromDate(""); setToDate(""); setSelectedIds(new Set()); }}
              className="text-xs text-muted-foreground hover:text-foreground px-1"
            >
              전체
            </button>
          )}
        </div>
        {selectedIds.size > 0 ? (
          <button
            onClick={deleteSelected}
            disabled={deleting}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50 transition-colors shrink-0"
          >
            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            선택 삭제 ({selectedIds.size}건)
          </button>
        ) : (
          <span className="text-xs text-muted-foreground ml-2 shrink-0">{filtered.length}건</span>
        )}
      </div>

      {/* 목록 */}
      <div className="overflow-x-auto max-h-[260px] overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-10">
            {provisions.length === 0 ? "등록된 제공이력이 없습니다." : "필터 조건에 맞는 이력이 없습니다."}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background/95 backdrop-blur-sm z-10">
              <tr className="text-xs text-muted-foreground border-b border-border text-left">
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                    className="cursor-pointer"
                    title="전체 선택/해제"
                  />
                </th>
                <th className="px-3 py-2">제공일</th>
                <th className="px-3 py-2">대상자</th>
                <th className="px-3 py-2">분류</th>
                <th className="px-3 py-2">항목</th>
                <th className="px-3 py-2">수량</th>
                <th className="px-3 py-2">제공기관</th>
                <th className="px-3 py-2">비고</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const c = clientById.get(p.client_id);
                const checked = selectedIds.has(p.id);
                return (
                  <tr
                    key={p.id}
                    className={`border-b border-border last:border-0 transition-colors ${
                      checked ? "bg-destructive/5" : "hover:bg-accent/30"
                    }`}
                  >
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(p.id)}
                        className="cursor-pointer"
                      />
                    </td>
                    <td
                      className="px-3 py-2 whitespace-nowrap text-xs cursor-pointer"
                      onClick={() => onSelectClient(p.client_id)}
                    >
                      {p.provided_at}
                      {p.provided_at > todayStr && (
                        <span className="ml-1 text-[10px] font-medium text-red-500">(예정)</span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-medium cursor-pointer" onClick={() => onSelectClient(p.client_id)}><ClientName c={c} fallback="-" /></td>
                    <td className="px-3 py-2 cursor-pointer" onClick={() => onSelectClient(p.client_id)}>
                      <Badge variant="outline" className={`text-[10px] ${categoryColor[p.category] ?? ""}`}>
                        {p.category}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 cursor-pointer" onClick={() => onSelectClient(p.client_id)}>{p.title}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground cursor-pointer" onClick={() => onSelectClient(p.client_id)}>{p.quantity ?? "-"}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground cursor-pointer" onClick={() => onSelectClient(p.client_id)}>{p.agency ?? "자체"}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground max-w-[10rem] truncate cursor-pointer" onClick={() => onSelectClient(p.client_id)}>{p.note ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
