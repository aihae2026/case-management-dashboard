import { ClientName } from "@/components/NameMask";
import { Fragment, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Package, Plus, Pencil, Trash2 } from "lucide-react";
import {
  PROVISION_CATEGORIES,
  PROVISION_PRESETS,
  categoryColor,
  getActiveCarePlanActions,
  programsOf,
  type Client,
  type Provision,
  type OrgRow,
} from "@/lib/case-types";
import { insertCarePlanActionLinks, syncCarePlanActionLinks, yearMapOf, applyLinksToActions, type CarePlanLinkRow } from "@/lib/care-plan-links";
import { AGENCY_PRESETS } from "./counsel-utils";

// ── 제공이력 패널 ────────────────────────────────────────────
export function ProvisionPanel({
  client,
  provisions,
  org,
  workerName,
  onChanged,
  planLinks = [],
}: {
  client: Client;
  provisions: Provision[];
  org: OrgRow | null;
  workerName: string;
  onChanged: () => void;
  planLinks?: CarePlanLinkRow[];
}) {
  const today = new Date().toLocaleDateString("en-CA");
  const [category, setCategory] = useState<string>(PROVISION_CATEGORIES[0]);
  const [title, setTitle] = useState("");
  const [quantity, setQuantity] = useState("");
  const [agency, setAgency] = useState("");
  const [agencyPreset, setAgencyPreset] = useState("");
  const [note, setNote] = useState("");
  const [providedAt, setProvidedAt] = useState(today);
  const [notProvided, setNotProvided] = useState(false);
  const [npReason, setNpReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submittingRef = useRef(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<{
    provided_at: string; category: string; title: string;
    quantity: string; agency: string; note: string;
  } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editAgencyPreset, setEditAgencyPreset] = useState("");
  // 수정 모드 계획 항목 연동
  const [editPlanLinkOpen, setEditPlanLinkOpen] = useState(false);
  const [editPlanSelectedIds, setEditPlanSelectedIds] = useState<Set<string>>(new Set());
  // 계획 항목 연동 (제공이력 등록 시)
  const [planLinkOpen, setPlanLinkOpen] = useState(false);
  const [planSelectedIds, setPlanSelectedIds] = useState<Set<string>>(new Set());
  const activePlanActions = useMemo(() => {
    const base = getActiveCarePlanActions(client);
    const clientLinks = planLinks.filter((l) => l.client_id === client.id);
    return applyLinksToActions(base, clientLinks);
  }, [client, planLinks]);

  // ── 필터 / 정렬 상태 ──────────────────────────────────────────
  const [filterCategory, setFilterCategory] = useState<string>("전체");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterKeyword, setFilterKeyword] = useState("");
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");

  function startEdit(p: Provision) {
    setEditingId(p.id);
    const existingAgency = p.agency ?? "";
    const isPreset = (AGENCY_PRESETS as readonly string[]).includes(existingAgency);
    setEditAgencyPreset(isPreset ? existingAgency : existingAgency ? "직접입력" : "");
    setEditFields({
      provided_at: p.provided_at,
      category: p.category,
      title: p.title,
      quantity: p.quantity ?? "",
      agency: existingAgency,
      note: p.note ?? "",
    });
    // 이미 연동된 계획 항목을 미리 체크 상태로 복원
    const preSelected = new Set(
      activePlanActions
        .filter((aa) => (aa.action.linkedProvIds ?? []).includes(p.id))
        .map((aa) => aa.action.id),
    );
    setEditPlanSelectedIds(preSelected);
    // 기존 연동 항목이 있으면 체크박스도 자동으로 열기
    setEditPlanLinkOpen(preSelected.size > 0);
  }

  async function saveEdit() {
    if (!editingId || !editFields) return;
    if (!editFields.title.trim()) return toast.error("항목을 입력해주세요.");
    setEditBusy(true);
    const { error } = await supabase.from("provisions").update({
      provided_at: editFields.provided_at,
      category: editFields.category,
      title: editFields.title.trim(),
      quantity: editFields.quantity.trim() || null,
      agency: editFields.agency.trim() || null,
      note: editFields.note.trim() || null,
    }).eq("id", editingId);
    if (error) { setEditBusy(false); return toast.error(error.message); }

    // 계획 항목 연동 — care_plan_action_links 표에만 저장한다. editPlanLinkOpen이 false(해제)면 빈 Set으로 기존 연결을 모두 제거(추가 + 해제 모두 반영)
    const effectiveProvIds = editPlanLinkOpen ? editPlanSelectedIds : new Set<string>();
    const linksOk = await syncCarePlanActionLinks(supabase, { clientId: client.id, orgId: client.org_id, linkedId: editingId, kind: "prov", actionIds: effectiveProvIds, yearByActionId: yearMapOf(activePlanActions) });

    setEditBusy(false);
    if (linksOk) toast.success("수정되었습니다.");
    else toast.error("제공이력은 수정됐지만 계획 항목 연동은 저장하지 못했어요. 다시 수정해서 연동을 확인해 주세요.");
    setEditingId(null);
    setEditFields(null);
    setEditPlanLinkOpen(false);
    setEditPlanSelectedIds(new Set());
    onChanged();
  }

  // 필터링 + 정렬
  const sorted = useMemo(() => {
    const kw = filterKeyword.trim().toLowerCase();
    return [...provisions]
      .filter((p) => {
        if (filterCategory !== "전체" && p.category !== filterCategory) return false;
        if (filterDateFrom && p.provided_at < filterDateFrom) return false;
        if (filterDateTo && p.provided_at > filterDateTo) return false;
        if (kw && !p.title.toLowerCase().includes(kw) && !(p.agency ?? "").toLowerCase().includes(kw)) return false;
        return true;
      })
      .sort((a, b) => {
        const diff = new Date(b.provided_at).getTime() - new Date(a.provided_at).getTime();
        return sortOrder === "desc" ? diff : -diff;
      });
  }, [provisions, filterCategory, filterDateFrom, filterDateTo, filterKeyword, sortOrder]);

  async function submit() {
    if (!org) return toast.error("기관 정보가 없습니다.");
    if (!providedAt) return toast.error("제공일을 입력해 주세요.");
    if (submittingRef.current) return; // 저장 중 Enter 반복으로 같은 제공이력이 여러 번 저장되는 것을 막는다
    submittingRef.current = true;
    try {
      await submitCore(org);
    } catch (e) {
      toast.error("저장 중 오류가 났어요: " + ((e as Error).message || ""));
    } finally {
      // 예외가 나도 저장 잠금이 풀리도록 한다
      submittingRef.current = false;
      setBusy(false);
    }
  }

  async function submitCore(org: OrgRow) {
    setBusy(true);

    if (notProvided) {
      // 미제공 → activity_logs 에 사유 기록 (일괄 등록과 동일 패턴)
      const { error } = await supabase.from("activity_logs").insert({
        client_id: client.id,
        org_id: org.id,
        method: "방문",
        note: `${title.trim() ? `${title.trim()} ` : ""}미제공${npReason.trim() ? ` — ${npReason.trim()}` : ""}`,
        worker_name: workerName || null,
        created_at: new Date(providedAt + "T12:00:00+09:00").toISOString(),
      });
      submittingRef.current = false; setBusy(false);
      if (error) return toast.error(error.message);
      toast.success("미제공 사유가 상담기록으로 저장되었습니다.");
      setNpReason("");
      setNotProvided(false);
      setTitle("");
      setProvidedAt(today);
      onChanged();
      return;
    }

    if (!title.trim()) { submittingRef.current = false; setBusy(false); return toast.error("항목을 입력해주세요."); }
    const { data: inserted, error } = await supabase.from("provisions").insert({
      client_id: client.id,
      org_id: org.id,
      category,
      title: title.trim(),
      quantity: quantity.trim() || null,
      agency: agency.trim() || null,
      note: note.trim() || null,
      provided_at: providedAt,
    }).select("id").single();
    submittingRef.current = false; setBusy(false);
    if (error) return toast.error(error.message);

    // 선택한 계획 항목에 연동 — care_plan_action_links 표에만 저장한다
    let linksOk = true;
    if (planLinkOpen && planSelectedIds.size > 0 && inserted) {
      const newProvId = (inserted as { id: string }).id;
      linksOk = await insertCarePlanActionLinks(supabase, { clientId: client.id, orgId: client.org_id, linkedId: newProvId, kind: "prov", actionIds: planSelectedIds, yearByActionId: yearMapOf(activePlanActions) });
    }

    if (linksOk) toast.success("제공이력이 등록되었습니다.");
    else toast.error("제공이력은 등록됐지만 계획 항목 연동은 저장하지 못했어요. 제공이력 수정에서 연동을 다시 선택해 주세요.");
    setTitle("");
    setQuantity("");
    setAgency("");
    setAgencyPreset("");
    setNote("");
    setProvidedAt(today);
    setPlanSelectedIds(new Set());
    onChanged();
  }

  async function deleteProvision(id: string) {
    if (!confirm("이 제공이력을 삭제하시겠어요?")) return;
    setDeletingId(id);
    const { error } = await supabase.from("provisions").delete().eq("id", id);
    setDeletingId(null);
    if (error) return toast.error(error.message);
    toast.success("삭제되었습니다.");
    onChanged();
  }

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card">
      {/* 헤더 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Package className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold"><ClientName c={client} /></span>
        <span className="text-sm text-muted-foreground">제공이력</span>
        <Badge variant="outline" className="ml-auto">
          {sorted.length !== provisions.length
            ? `${sorted.length} / ${provisions.length}건`
            : `${provisions.length}건`}
        </Badge>
      </div>

      {/* 필터 바 */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border bg-muted/20">
        {/* 분류 */}
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="h-7 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="전체">분류 전체</option>
          {PROVISION_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {/* 날짜 범위 */}
        <div className="flex items-center gap-1">
          <input
            type="date"
            value={filterDateFrom}
            onChange={(e) => setFilterDateFrom(e.target.value)}
            className="h-7 rounded border border-input bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <span className="text-xs text-muted-foreground">~</span>
          <input
            type="date"
            value={filterDateTo}
            onChange={(e) => setFilterDateTo(e.target.value)}
            className="h-7 rounded border border-input bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        {/* 항목명 검색 */}
        <input
          type="text"
          value={filterKeyword}
          onChange={(e) => setFilterKeyword(e.target.value)}
          placeholder="항목명·기관 검색"
          className="h-7 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary w-32"
        />
        {/* 정렬 */}
        <select
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value as "desc" | "asc")}
          className="h-7 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary ml-auto"
        >
          <option value="desc">최신순</option>
          <option value="asc">오래된순</option>
        </select>
        {/* 필터 초기화 */}
        {(filterCategory !== "전체" || filterDateFrom || filterDateTo || filterKeyword) && (
          <button
            type="button"
            onClick={() => { setFilterCategory("전체"); setFilterDateFrom(""); setFilterDateTo(""); setFilterKeyword(""); }}
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground rounded border border-input bg-background"
          >
            초기화
          </button>
        )}
      </div>

      {/* 이력 목록 */}
      <div className="overflow-y-auto min-h-[150px] max-h-[45dvh] bg-accent/10">
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-10">
            등록된 제공이력이 없습니다. 아래에서 첫 제공이력을 등록해보세요.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background/95 backdrop-blur-sm z-10">
              <tr className="text-xs text-muted-foreground border-b border-border text-left">
                <th className="px-3 py-2">제공일</th>
                <th className="px-3 py-2">분류</th>
                <th className="px-3 py-2">항목</th>
                <th className="px-3 py-2">수량</th>
                <th className="px-3 py-2">제공기관</th>
                <th className="px-3 py-2">비고</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => {
                const isEditing = editingId === p.id;
                return isEditing && editFields ? (
                  <Fragment key={p.id}>
                  {/* 수정 모드 행 */}
                  <tr className="border-b border-border bg-accent/20">
                    <td className="px-2 py-1.5">
                      <input type="date" value={editFields.provided_at}
                        onChange={(e) => setEditFields((f) => f && ({ ...f, provided_at: e.target.value }))}
                        className="h-7 w-28 rounded border border-input bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
                    </td>
                    <td className="px-2 py-1.5">
                      <select value={editFields.category}
                        onChange={(e) => setEditFields((f) => f && ({ ...f, category: e.target.value }))}
                        className="h-7 rounded border border-input bg-background px-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary">
                        {PROVISION_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <input value={editFields.title}
                        onChange={(e) => setEditFields((f) => f && ({ ...f, title: e.target.value }))}
                        className="h-7 w-full min-w-[6rem] rounded border border-input bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
                    </td>
                    <td className="px-2 py-1.5">
                      <input value={editFields.quantity} placeholder="-"
                        onChange={(e) => setEditFields((f) => f && ({ ...f, quantity: e.target.value }))}
                        className="h-7 w-16 rounded border border-input bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
                    </td>
                    <td className="px-2 py-1.5">
                      <select value={editAgencyPreset}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditAgencyPreset(val);
                          if (val !== "직접입력") setEditFields((f) => f && ({ ...f, agency: val }));
                          else setEditFields((f) => f && ({ ...f, agency: "" }));
                        }}
                        className="h-7 rounded border border-input bg-background px-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary">
                        <option value="">선택</option>
                        {AGENCY_PRESETS.map((a) => <option key={a} value={a}>{a}</option>)}
                        <option value="직접입력">직접입력</option>
                      </select>
                      {editAgencyPreset === "직접입력" && (
                        <input value={editFields.agency} placeholder="기관명"
                          onChange={(e) => setEditFields((f) => f && ({ ...f, agency: e.target.value }))}
                          className="mt-1 h-7 w-full rounded border border-input bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <input value={editFields.note}
                        onChange={(e) => setEditFields((f) => f && ({ ...f, note: e.target.value }))}
                        className="h-7 w-24 rounded border border-input bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={saveEdit} disabled={editBusy}
                          className="text-[10px] px-2 py-0.5 rounded bg-primary text-primary-foreground disabled:opacity-50">
                          {editBusy ? <Loader2 className="h-3 w-3 animate-spin inline" /> : "저장"}
                        </button>
                        <button type="button" onClick={() => { setEditingId(null); setEditFields(null); setEditPlanLinkOpen(false); setEditPlanSelectedIds(new Set()); }}
                          className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent">
                          취소
                        </button>
                      </div>
                    </td>
                  </tr>
                  {/* 계획 항목 연동 행 */}
                  {activePlanActions.length === 0 && programsOf(client).includes("사례관리") && (
                    <tr key={p.id + "-plan-hint"} className="bg-muted/10">
                      <td colSpan={7} className="px-3 py-2 text-[11px] text-muted-foreground">
                        사례관리 계획 점검 연동 — 재사정 기록지에 행동계획이 등록되면 활성화됩니다.
                      </td>
                    </tr>
                  )}
                  {activePlanActions.length > 0 && (
                    <tr key={p.id + "-plan"} className="bg-muted/10">
                      <td colSpan={7} className="px-3 pb-3">
                        <div className="space-y-1.5 pt-1">
                          <label className="flex items-center gap-2 cursor-pointer w-fit">
                            <Checkbox
                              checked={editPlanLinkOpen}
                              onCheckedChange={(checked) => {
                                setEditPlanLinkOpen(!!checked);
                                if (!checked) setEditPlanSelectedIds(new Set());
                              }}
                            />
                            <span className="text-xs font-medium">사례관리 계획 점검 연동</span>
                            <span className="text-[11px] text-muted-foreground">(선택 안 해도 됨)</span>
                          </label>
                          {editPlanLinkOpen && (
                            <div className="rounded-md border border-border divide-y divide-border max-h-36 overflow-y-auto bg-card">
                              {activePlanActions.some(({ role }) => role === "self") && <div className="px-3 py-0.5 bg-blue-50/60 dark:bg-blue-950/20 text-[10px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide sticky top-0">당사자</div>}
                              {activePlanActions.filter(({ role }) => role === "self").map(({ action }) => (
                                <label key={action.id} className={`flex items-center gap-2.5 px-3 py-1.5 cursor-pointer text-xs hover:bg-muted/40 transition-colors ${editPlanSelectedIds.has(action.id) ? "bg-primary/5" : ""}`}>
                                  <Checkbox checked={editPlanSelectedIds.has(action.id)} onCheckedChange={(checked) => { setEditPlanSelectedIds((prev) => { const next = new Set(prev); if (checked) next.add(action.id); else next.delete(action.id); return next; }); }} />
                                  <span className="truncate">{action.text}</span>
                                  {action.targetCount && <span className="text-[11px] text-muted-foreground shrink-0">목표 {action.targetCount}{action.unit ?? ""}</span>}
                                </label>
                              ))}
                              {activePlanActions.some(({ role }) => role === "worker") && <div className="px-3 py-0.5 bg-violet-50/60 dark:bg-violet-950/20 text-[10px] font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wide sticky top-0">담당자</div>}
                              {activePlanActions.filter(({ role }) => role === "worker").map(({ action }) => (
                                <label key={action.id} className={`flex items-center gap-2.5 px-3 py-1.5 cursor-pointer text-xs hover:bg-muted/40 transition-colors ${editPlanSelectedIds.has(action.id) ? "bg-primary/5" : ""}`}>
                                  <Checkbox checked={editPlanSelectedIds.has(action.id)} onCheckedChange={(checked) => { setEditPlanSelectedIds((prev) => { const next = new Set(prev); if (checked) next.add(action.id); else next.delete(action.id); return next; }); }} />
                                  <span className="truncate">{action.text}</span>
                                  {action.targetCount && <span className="text-[11px] text-muted-foreground shrink-0">목표 {action.targetCount}{action.unit ?? ""}</span>}
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ) : (
                  /* 일반 표시 행 */
                  <tr key={p.id} className="border-b border-border last:border-0 hover:bg-accent/30 transition-colors">
                    <td className="px-3 py-2 whitespace-nowrap text-xs">{p.provided_at}</td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className={`text-[10px] ${categoryColor[p.category] ?? ""}`}>
                        {p.category}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 font-medium">{p.title}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{p.quantity ?? "-"}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{p.agency ?? "자체"}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground max-w-[12rem] truncate">{p.note ?? ""}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <button type="button" onClick={() => startEdit(p)}
                          className="text-muted-foreground hover:text-primary" title="수정">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={() => deleteProvision(p.id)} disabled={deletingId === p.id}
                          className="text-muted-foreground hover:text-destructive disabled:opacity-40" title="삭제">
                          {deletingId === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 입력 폼 */}
      <div className="border-t border-border p-4 space-y-3 bg-background">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">새 제공이력 등록</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {/* 제공일 */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">제공일</label>
            <input
              type="date"
              value={providedAt}
              max={today}
              onChange={(e) => setProvidedAt(e.target.value)}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          {/* 분류 */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">분류</label>
            <Select value={category} onValueChange={(v) => { setCategory(v); setNotProvided(false); setNpReason(""); }}>
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
          {/* 항목 */}
          <div className="space-y-1 col-span-2">
            <label className="text-xs text-muted-foreground">
              항목 {!notProvided && <span className="text-destructive">*</span>}
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="아래에서 선택하거나 직접 입력"
              className="h-8"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
            />
          </div>
        </div>

        {/* 미제공 토글 — 항상 표시 */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="provision-panel-np"
            checked={notProvided}
            onChange={(e) => { setNotProvided(e.target.checked); setNpReason(""); }}
            className="h-4 w-4 accent-amber-500"
          />
          <label htmlFor="provision-panel-np" className="text-sm text-amber-700 dark:text-amber-400 cursor-pointer select-none font-medium">
            미제공 (수령 거부 · 부재 등)
          </label>
        </div>

        {/* 미제공 사유 입력 */}
        {notProvided && (
          <div className="space-y-1 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3">
            <label className="text-xs text-amber-700 dark:text-amber-400 font-medium">미제공 사유</label>
            <Input
              value={npReason}
              onChange={(e) => setNpReason(e.target.value)}
              placeholder="예: 입원, 외출, 거부 (비워두면 사유 없이 저장)"
              className="h-8 border-amber-300 dark:border-amber-700"
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">상담기록(방문)으로 자동 저장됩니다.</p>
          </div>
        )}

        {/* 항목 빠른선택 칩 */}
        {PROVISION_PRESETS[category] && (
          <div className="flex flex-wrap gap-1.5">
            {PROVISION_PRESETS[category].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setTitle(preset)}
                className={`px-2.5 py-0.5 rounded-full text-xs border transition-colors ${
                  title === preset
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                {preset}
              </button>
            ))}
          </div>
        )}
        {!notProvided && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {/* 수량 */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">수량/횟수</label>
              <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="예: 30회, 1박스" className="h-8" />
            </div>
            {/* 제공기관 */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">제공기관</label>
              <Select value={agencyPreset} onValueChange={(val) => {
                setAgencyPreset(val);
                if (val !== "직접입력") setAgency(val);
                else setAgency("");
              }}>
                <SelectTrigger className="h-8 text-xs">
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
            {/* 비고 */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">비고</label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="메모" className="h-8" />
            </div>
          </div>
        )}
        {/* 계획 항목 연동 (미제공 제외) */}
        {!notProvided && activePlanActions.length === 0 && programsOf(client).includes("사례관리") && (
          <p className="text-[11px] text-muted-foreground">
            사례관리 계획 점검 연동 — 재사정 기록지에 행동계획이 등록되면 활성화됩니다.
          </p>
        )}
        {!notProvided && activePlanActions.length > 0 && (
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 cursor-pointer w-fit">
              <Checkbox
                checked={planLinkOpen}
                onCheckedChange={(checked) => {
                  setPlanLinkOpen(!!checked);
                  if (!checked) setPlanSelectedIds(new Set());
                }}
              />
              <span className="text-sm font-medium">사례관리 계획 점검 연동</span>
              <span className="text-xs text-muted-foreground">(선택 안 해도 됨)</span>
            </label>
            {planLinkOpen && (
              <div className="rounded-md border border-border divide-y divide-border max-h-40 overflow-y-auto bg-card">
                {activePlanActions.some(({ role }) => role === "self") && <div className="px-3 py-0.5 bg-blue-50/60 dark:bg-blue-950/20 text-[10px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide sticky top-0">당사자</div>}
                {activePlanActions.filter(({ role }) => role === "self").map(({ action }) => (
                  <label key={action.id} className={`flex items-center gap-2.5 px-3 py-1.5 cursor-pointer text-sm hover:bg-muted/40 transition-colors ${planSelectedIds.has(action.id) ? "bg-primary/5" : ""}`}>
                    <Checkbox checked={planSelectedIds.has(action.id)} onCheckedChange={(checked) => { setPlanSelectedIds((prev) => { const next = new Set(prev); if (checked) next.add(action.id); else next.delete(action.id); return next; }); }} />
                    <span className="truncate">{action.text}</span>
                    {action.targetCount && <span className="text-[11px] text-muted-foreground shrink-0">목표 {action.targetCount}{action.unit ?? ""}</span>}
                  </label>
                ))}
                {activePlanActions.some(({ role }) => role === "worker") && <div className="px-3 py-0.5 bg-violet-50/60 dark:bg-violet-950/20 text-[10px] font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wide sticky top-0">담당자</div>}
                {activePlanActions.filter(({ role }) => role === "worker").map(({ action }) => (
                  <label key={action.id} className={`flex items-center gap-2.5 px-3 py-1.5 cursor-pointer text-sm hover:bg-muted/40 transition-colors ${planSelectedIds.has(action.id) ? "bg-primary/5" : ""}`}>
                    <Checkbox checked={planSelectedIds.has(action.id)} onCheckedChange={(checked) => { setPlanSelectedIds((prev) => { const next = new Set(prev); if (checked) next.add(action.id); else next.delete(action.id); return next; }); }} />
                    <span className="truncate">{action.text}</span>
                    {action.targetCount && <span className="text-[11px] text-muted-foreground shrink-0">목표 {action.targetCount}{action.unit ?? ""}</span>}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end">
          <Button onClick={submit} disabled={busy || (!notProvided && !title.trim())} className="gap-1.5">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {notProvided ? "미제공 사유 저장" : "제공이력 등록"}
          </Button>
        </div>
      </div>
    </div>
  );
}
