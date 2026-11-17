import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVISION_CATEGORIES, PROVISION_PRESETS, type Provision } from "@/lib/case-types";
import { AGENCY_PRESETS } from "./counsel-utils";

// ── 상담 입력 화면에서 제공이력을 함께 등록하는 입력 칸 ─────────────
// 상담 [저장] 때 ChatPanel 이 이 행들을 provisions 에 같이 넣는다(저장 버튼은 따로 없음).

export type ProvisionDraft = {
  key: string;
  category: string;
  title: string;
  quantity: string;
  agencyPreset: string;
  agency: string;
  note: string;
  /** 비어 있으면 상담 날짜를 따라간다 */
  providedAt: string;
};

let draftSeq = 0;
export function newProvisionDraft(): ProvisionDraft {
  draftSeq += 1;
  return {
    key: `pd-${Date.now()}-${draftSeq}`,
    category: PROVISION_CATEGORIES[0],
    title: "",
    quantity: "",
    agencyPreset: "",
    agency: "",
    note: "",
    providedAt: "",
  };
}

/** 아무것도 안 적은 행인지 */
function isBlank(d: ProvisionDraft) {
  return !d.title.trim() && !d.quantity.trim() && !d.agency.trim() && !d.note.trim();
}

/**
 * 저장할 행만 골라 provisions insert 용 값으로 바꾼다. 항목을 안 적은 행이 있으면 error 로 알린다.
 * counselDate: 상담 날짜(YYYY-MM-DD). 행에 제공일이 없으면 이 날짜를 쓴다.
 */
export function buildProvisionRows(
  drafts: ProvisionDraft[],
  ctx: { clientId: string; orgId: string; counselDate: string },
): { rows: Omit<Provision, "id">[]; error?: string } {
  const rows: Omit<Provision, "id">[] = [];
  for (const d of drafts) {
    if (isBlank(d)) continue;
    if (!d.title.trim()) return { rows: [], error: "제공이력의 항목을 입력해 주세요. 등록하지 않으려면 체크를 해제하세요." };
    rows.push({
      client_id: ctx.clientId,
      org_id: ctx.orgId,
      category: d.category,
      title: d.title.trim(),
      quantity: d.quantity.trim() || null,
      agency: d.agency.trim() || null,
      note: d.note.trim() || null,
      provided_at: d.providedAt || ctx.counselDate,
    });
  }
  if (rows.length === 0) return { rows: [], error: "제공이력의 항목을 입력해 주세요. 등록하지 않으려면 체크를 해제하세요." };
  return { rows };
}

/** 같은 날 같은 항목이 이미 등록돼 있는지(대소문자·공백 무시) */
export function findDuplicateProvisions(rows: Omit<Provision, "id">[], existing: Provision[]): Omit<Provision, "id">[] {
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  return rows.filter((r) =>
    existing.some(
      (p) => p.client_id === r.client_id && p.provided_at.slice(0, 10) === r.provided_at && norm(p.title) === norm(r.title),
    ),
  );
}

export function ProvisionQuickAdd({
  drafts,
  onChange,
  counselDate,
}: {
  drafts: ProvisionDraft[];
  onChange: (next: ProvisionDraft[]) => void;
  counselDate: string;
}) {
  const today = new Date().toLocaleDateString("en-CA");
  const patch = (key: string, p: Partial<ProvisionDraft>) =>
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...p } : d)));

  return (
    <div className="space-y-3 rounded-md border border-border bg-background p-3">
      <p className="text-xs font-medium text-muted-foreground">
        제공한 내용 — 상담 [저장]을 누르면 제공이력으로 함께 등록돼요.
      </p>
      {drafts.map((d, idx) => (
        <div key={d.key} className={`space-y-2 ${idx > 0 ? "border-t border-border pt-3" : ""}`}>
          {drafts.length > 1 && (
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">{idx + 1}번째 제공이력</span>
              <button
                type="button"
                onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}
                className="text-muted-foreground hover:text-destructive"
                title="이 제공이력 빼기"
                aria-label="이 제공이력 빼기"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">제공일</label>
              <input
                type="date"
                value={d.providedAt || counselDate}
                max={today}
                onChange={(e) => patch(d.key, { providedAt: e.target.value })}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">분류</label>
              <Select value={d.category} onValueChange={(v) => patch(d.key, { category: v })}>
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
              <label className="text-xs text-muted-foreground">
                항목 <span className="text-destructive">*</span>
              </label>
              <Input
                value={d.title}
                onChange={(e) => patch(d.key, { title: e.target.value })}
                placeholder="아래에서 선택하거나 직접 입력"
                className="h-8"
                onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
              />
            </div>
          </div>
          {PROVISION_PRESETS[d.category] && (
            <div className="flex flex-wrap gap-1.5">
              {PROVISION_PRESETS[d.category].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => patch(d.key, { title: preset })}
                  className={`px-2.5 py-0.5 rounded-full text-xs border transition-colors ${
                    d.title === preset
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  {preset}
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">수량/횟수</label>
              <Input value={d.quantity} onChange={(e) => patch(d.key, { quantity: e.target.value })} placeholder="예: 30회, 1박스" className="h-8" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">제공기관</label>
              <Select
                value={d.agencyPreset}
                onValueChange={(val) => patch(d.key, { agencyPreset: val, agency: val === "직접입력" ? "" : val })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="선택 또는 직접입력" />
                </SelectTrigger>
                <SelectContent>
                  {AGENCY_PRESETS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                  <SelectItem value="직접입력">직접입력</SelectItem>
                </SelectContent>
              </Select>
              {d.agencyPreset === "직접입력" && (
                <Input value={d.agency} onChange={(e) => patch(d.key, { agency: e.target.value })} placeholder="기관명 입력" className="h-8 mt-1" />
              )}
            </div>
            <div className="space-y-1 col-span-2 sm:col-span-1">
              <label className="text-xs text-muted-foreground">비고</label>
              <Input value={d.note} onChange={(e) => patch(d.key, { note: e.target.value })} placeholder="메모" className="h-8" />
            </div>
          </div>
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground">
        구체적인 물품(예: 이불)은 항목이나 비고에 적어 주세요. 자원 배분 도우미가 이미 제공한 물품을 가려내는 데 쓰여요.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        onClick={() => onChange([...drafts, newProvisionDraft()])}
      >
        <Plus className="h-3.5 w-3.5" />
        제공이력 추가
      </Button>
    </div>
  );
}
