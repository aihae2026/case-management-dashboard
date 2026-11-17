import { openDriveFile } from "@/lib/drive-viewer";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AiModelBadge } from "@/components/AiModelBadge";
import { useServerFn } from "@tanstack/react-start";
import { analyzeClosureReport } from "@/lib/ai.functions";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { AI_REFUSED_MESSAGE, isAiBlocked } from "@/lib/ai-consent";
import {
  Plus, Trash2, Loader2, FileText, Save, Upload, Sparkles, X, Pencil,
} from "lucide-react";
import type { Client } from "@/lib/case-types";
import type { Json } from "@/integrations/supabase/types";

// ────────────────────────────────────────────────
// 타입
// ────────────────────────────────────────────────
interface ServiceHistoryRow { date: string; content: string; }
interface CaseStatus {
  인테이크?: string; 재사정?: string; 사례회의?: string; 서비스계획?: string; 서비스점검?: string;
}
interface DriveFile {
  name: string; driveUrl: string; driveId: string; type?: string; extractedTextDriveId?: string;
}
interface ClosureReport {
  closure_date: string;
  case_status: CaseStatus;
  service_history: ServiceHistoryRow[];
  closure_reason: string;
  worker_opinion: string;
  closure_type: string;
  closure_type_detail: string;
  closure_result: string;
  referral_org: string;
  written_by: string;
  files: DriveFile[];
}

const EMPTY: ClosureReport = {
  closure_date: "",
  case_status: { 인테이크: "", 재사정: "", 사례회의: "", 서비스계획: "", 서비스점검: "" },
  service_history: [{ date: "", content: "" }],
  closure_reason: "",
  worker_opinion: "",
  closure_type: "",
  closure_type_detail: "",
  closure_result: "종결",
  referral_org: "",
  written_by: "",
  files: [],
};

const CLOSURE_TYPES = ["서비스거부", "연락두절", "이사", "사망", "기타"] as const;
const CASE_STATUS_KEYS = ["인테이크", "재사정", "사례회의", "서비스계획", "서비스점검"] as const;

// ────────────────────────────────────────────────
// PDF 헬퍼
// ────────────────────────────────────────────────
async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(
      content.items.map((it) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " ").trim(),
    );
  }
  return parts.filter(Boolean).join("\n");
}

function aiErrMsg(msg: string): string {
  if (/\b429\b|quota|rate.?limit|exceeded/i.test(msg))
    return "AI 사용량(quota)을 초과했어요. 1~2분 뒤 다시 시도해 주세요.";
  return "AI 분석 실패: " + msg;
}

// ────────────────────────────────────────────────
// 읽기 전용 요약 뷰
// ────────────────────────────────────────────────
function ClosureReportView({
  report,
  onDeleteFile,
}: {
  report: ClosureReport;
  onDeleteFile?: (i: number) => void;
}) {
  const hasContent =
    report.closure_date || report.closure_reason || report.worker_opinion ||
    report.closure_type || report.written_by ||
    report.service_history.some((r) => r.date || r.content);

  if (!hasContent) {
    return (
      <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
        <FileText className="h-7 w-7 mx-auto mb-2 opacity-40" />
        종결보고서가 없습니다. [직접 작성] 또는 [PDF 선택]으로 시작하세요. 기존 내용을 변경하려면 [수정]을 누르세요.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 종결 핵심 정보 요약 바 */}
      <div className="rounded-md border border-border bg-muted/40 p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
          {report.closure_date && (
            <span className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">종결일</span>
              <strong className="text-foreground">{report.closure_date}</strong>
            </span>
          )}
          {report.written_by && (
            <span className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">담당</span>
              <strong className="text-foreground">{report.written_by}</strong>
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {report.closure_type && (
            <Badge className="bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-700 text-xs px-2.5 py-0.5">
              종결유형: {report.closure_type}
              {report.closure_type === "기타" && report.closure_type_detail ? ` (${report.closure_type_detail})` : ""}
            </Badge>
          )}
          {report.closure_result && (
            <Badge className={
              report.closure_result === "타기관의뢰"
                ? "bg-orange-100 text-orange-800 border border-orange-300 dark:bg-orange-900/30 dark:text-orange-200 dark:border-orange-700 text-xs px-2.5 py-0.5"
                : "bg-primary/10 text-primary border border-primary/30 text-xs px-2.5 py-0.5"
            }>
              {report.closure_result}
              {report.closure_result === "타기관의뢰" && report.referral_org ? ` → ${report.referral_org}` : ""}
            </Badge>
          )}
        </div>
      </div>

      {/* 사례관리 현황 */}
      {CASE_STATUS_KEYS.some((k) => (report.case_status as Record<string,string>)[k]) && (
        <div className="rounded-md border border-border p-3">
          <div className="text-xs font-semibold text-primary mb-2">사례관리 현황</div>
          <div className="grid grid-cols-5 gap-2 text-xs text-center">
            {CASE_STATUS_KEYS.map((k) => (
              <div key={k} className="space-y-0.5">
                <div className="text-muted-foreground">{k}</div>
                <div className="font-medium">{(report.case_status as Record<string,string>)[k] || "-"}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 서비스 제공현황 */}
      {report.service_history.some((r) => r.date || r.content) && (
        <div className="rounded-md border border-border p-3">
          <div className="text-xs font-semibold text-primary mb-2">서비스 제공현황</div>
          <div className="space-y-1">
            {report.service_history.filter((r) => r.date || r.content).map((row, i) => (
              <div key={i} className="flex gap-2 text-sm">
                <span className="text-muted-foreground w-28 shrink-0">{row.date || "-"}</span>
                <span>{row.content || "-"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 종결 사유 */}
      {report.closure_reason && (
        <div className="rounded-md border border-border p-3">
          <div className="text-xs font-semibold text-primary mb-1">종결 사유</div>
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{report.closure_reason}</p>
        </div>
      )}

      {/* 담당자 의견 */}
      {report.worker_opinion && (
        <div className="rounded-md border border-border p-3">
          <div className="text-xs font-semibold text-primary mb-1">담당자 의견</div>
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{report.worker_opinion}</p>
        </div>
      )}

      {/* 첨부 파일 */}
      {report.files.length > 0 && (
        <div className="rounded-md border border-border p-2.5">
          <div className="text-xs font-semibold text-primary mb-1">첨부 파일</div>
          <div className="space-y-1">
            {report.files.map((f, i) => (
              <div key={i} className="flex items-center gap-1 group">
                <button
                  type="button"
                  onClick={() => openDriveFile(f.driveUrl, f.name, { kind: "종결보고 첨부" })}
                  className="inline-flex items-center gap-1 text-xs underline hover:text-foreground"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  {f.name}
                </button>
                {onDeleteFile && (
                  <button
                    type="button"
                    onClick={() => onDeleteFile(i)}
                    className="ml-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                    title="파일 삭제"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────
// 직접 작성 Dialog (폼)
// ────────────────────────────────────────────────
function ClosureFormDialog({
  open,
  onOpenChange,
  initial,
  onSave,
  title = "서비스 종결 평가 보고서",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial: ClosureReport;
  onSave: (r: ClosureReport) => Promise<void>;
  title?: string;
}) {
  const [f, setF] = useState<ClosureReport>(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setF(structuredClone(initial));
  }, [open, initial]);

  function updateHistoryRow(idx: number, field: keyof ServiceHistoryRow, value: string) {
    setF((prev) => {
      const next = [...prev.service_history];
      next[idx] = { ...next[idx], [field]: value };
      return { ...prev, service_history: next };
    });
  }
  function addHistoryRow() {
    setF((prev) => ({ ...prev, service_history: [...prev.service_history, { date: "", content: "" }] }));
  }
  function removeHistoryRow(idx: number) {
    setF((prev) => ({ ...prev, service_history: prev.service_history.filter((_, i) => i !== idx) }));
  }

  async function handleSave() {
    setSaving(true);
    await onSave(f);
    setSaving(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>종결보고서 내용을 입력하고 저장하세요.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* 종결평가 일자 + 작성자 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">종결평가 일자</Label>
              <Input
                type="date"
                value={f.closure_date}
                onChange={(e) => setF((p) => ({ ...p, closure_date: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">작성자(담당)</Label>
              <Input
                placeholder="담당자 이름"
                value={f.written_by}
                onChange={(e) => setF((p) => ({ ...p, written_by: e.target.value }))}
              />
            </div>
          </div>

          {/* 사례관리 현황 */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold">사례관리 현황</Label>
            <div className="grid grid-cols-5 gap-2">
              {CASE_STATUS_KEYS.map((key) => (
                <div key={key} className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{key}</Label>
                  <Input
                    className="text-center text-sm"
                    placeholder="-"
                    value={(f.case_status as Record<string, string>)[key] ?? ""}
                    onChange={(e) =>
                      setF((p) => ({ ...p, case_status: { ...p.case_status, [key]: e.target.value } }))
                    }
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">예: "1회", "2회", "-"</p>
          </div>

          {/* 서비스 제공현황 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold">서비스 제공현황</Label>
              <Button size="sm" variant="outline" onClick={addHistoryRow}>
                <Plus className="h-3.5 w-3.5 mr-1" /> 행 추가
              </Button>
            </div>
            <div className="space-y-2">
              {f.service_history.map((row, idx) => (
                <div key={idx} className="flex gap-2 items-center">
                  <Input
                    className="w-36 shrink-0 text-sm"
                    placeholder="날짜 (예: 2024.01.15)"
                    value={row.date}
                    onChange={(e) => updateHistoryRow(idx, "date", e.target.value)}
                  />
                  <Input
                    className="flex-1 text-sm"
                    placeholder="서비스 내용"
                    value={row.content}
                    onChange={(e) => updateHistoryRow(idx, "content", e.target.value)}
                  />
                  {f.service_history.length > 1 && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="shrink-0 h-9 w-9 text-muted-foreground hover:text-destructive"
                      onClick={() => removeHistoryRow(idx)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 종결 사유 */}
          <div className="space-y-1">
            <Label className="text-xs font-semibold">종결 사유</Label>
            <Textarea
              rows={5}
              placeholder={"[대상자의 변화]\n\n[현재 상황]\n\n[종결 사유]"}
              value={f.closure_reason}
              onChange={(e) => setF((p) => ({ ...p, closure_reason: e.target.value }))}
            />
          </div>

          {/* 담당자 의견 */}
          <div className="space-y-1">
            <Label className="text-xs font-semibold">담당자 의견</Label>
            <Textarea
              rows={4}
              placeholder="담당자 의견을 입력하세요."
              value={f.worker_opinion}
              onChange={(e) => setF((p) => ({ ...p, worker_opinion: e.target.value }))}
            />
          </div>

          {/* 종결 유형 */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold">종결 유형</Label>
            <div className="flex flex-wrap gap-3">
              {CLOSURE_TYPES.map((type) => (
                <label key={type} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="closure_type_dialog"
                    value={type}
                    checked={f.closure_type === type}
                    onChange={() => setF((p) => ({ ...p, closure_type: type, closure_type_detail: "" }))}
                    className="accent-primary"
                  />
                  <span className="text-sm">{type}</span>
                </label>
              ))}
            </div>
            {f.closure_type === "기타" && (
              <Input
                className="max-w-xs text-sm"
                placeholder="기타 사유 입력 (예: 장기입원)"
                value={f.closure_type_detail}
                onChange={(e) => setF((p) => ({ ...p, closure_type_detail: e.target.value }))}
              />
            )}
          </div>

          {/* 종결평가 결과 */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold">종결평가 결과</Label>
            <div className="flex flex-wrap gap-6">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="closure_result_dialog"
                  value="종결"
                  checked={f.closure_result === "종결"}
                  onChange={() => setF((p) => ({ ...p, closure_result: "종결", referral_org: "" }))}
                  className="accent-primary"
                />
                <span className="text-sm font-medium">종결</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="closure_result_dialog"
                  value="타기관의뢰"
                  checked={f.closure_result === "타기관의뢰"}
                  onChange={() => setF((p) => ({ ...p, closure_result: "타기관의뢰" }))}
                  className="accent-primary"
                />
                <span className="text-sm font-medium">타기관 의뢰</span>
              </label>
            </div>
            {f.closure_result === "타기관의뢰" && (
              <Input
                className="max-w-xs text-sm"
                placeholder="의뢰 기관명"
                value={f.referral_org}
                onChange={(e) => setF((p) => ({ ...p, referral_org: e.target.value }))}
              />
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>취소</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
            저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────
// 메인 컴포넌트
// ────────────────────────────────────────────────
interface Props { client: Client; onChanged?: () => void; }

export function ClosureReportTab({ client, onChanged }: Props) {
  const [report, setReport] = useState<ClosureReport>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [reportId, setReportId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDraft, setAiDraft] = useState<ClosureReport | null>(null);
  const [aiConfirmOpen, setAiConfirmOpen] = useState(false);
  const isTerminated = client.grade === "종결";

  const runAnalyze = useServerFn(analyzeClosureReport);

  // ── 불러오기 ──
  useEffect(() => {
    let cancelled = false;
    // 다른 대상자로 바뀌면 이전 대상자의 보고서가 남지 않도록 먼저 비운다
    // (남아 있으면 새 대상자에 이전 대상자의 종결보고가 보이고, 저장하면 보고서가 옮겨 간다)
    setReportId(null);
    setReport(EMPTY);
    setAiDraft(null);
    setAiConfirmOpen(false);
    setDialogOpen(false);
    setEditOpen(false);
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("closure_reports")
        .select("*")
        .eq("client_id", client.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      if (data) {
        setReportId(data.id);
        setReport({
          closure_date: data.closure_date ?? "",
          case_status: (data.case_status as unknown as CaseStatus) ?? EMPTY.case_status,
          service_history: (data.service_history as unknown as ServiceHistoryRow[])?.length
            ? (data.service_history as unknown as ServiceHistoryRow[])
            : [{ date: "", content: "" }],
          closure_reason: data.closure_reason ?? "",
          worker_opinion: data.worker_opinion ?? "",
          closure_type: data.closure_type ?? "",
          closure_type_detail: data.closure_type_detail ?? "",
          closure_result: data.closure_result ?? "종결",
          referral_org: data.referral_org ?? "",
          written_by: data.written_by ?? "",
          files: (data.files as unknown as DriveFile[]) ?? [],
        });
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [client.id]);

  // ── 저장 (내부 공용) ──
  async function saveReport(r: ClosureReport, silent = false) {
    const payload = {
      org_id: client.org_id,
      client_id: client.id,
      closure_date: r.closure_date || null,
      case_status: r.case_status as unknown as Json,
      service_history: r.service_history.filter((x) => x.date || x.content) as unknown as Json,
      closure_reason: r.closure_reason,
      worker_opinion: r.worker_opinion,
      closure_type: r.closure_type,
      closure_type_detail: r.closure_type_detail,
      closure_result: r.closure_result,
      referral_org: r.referral_org,
      written_by: r.written_by,
      files: r.files as unknown as Json,
      updated_at: new Date().toISOString(),
    };
    let error, newId: string | undefined;
    if (reportId) {
      // client_id 까지 맞는 행만 수정한다(다른 대상자의 보고서를 이 대상자로 옮기지 않도록)
      const { data: upd, error: e } = await supabase
        .from("closure_reports")
        .update(payload)
        .eq("id", reportId)
        .eq("client_id", client.id)
        .select("id");
      error = e ?? (upd?.length ? null : new Error("이 대상자의 종결보고서를 찾을 수 없어요. 화면을 새로고침한 뒤 다시 시도해 주세요."));
    } else {
      const { data, error: e } = await supabase
        .from("closure_reports").insert(payload).select("id").single();
      error = e;
      if (data) { newId = data.id; setReportId(data.id); }
    }
    if (error) { toast.error("저장 실패: " + error.message); return false; }
    if (!silent) toast.success("종결보고서가 저장됐습니다.");
    setReport(r);
    onChanged?.();
    return true;
  }

  // 수정 Dialog 저장 (기존 파일 유지)
  async function handleEditSave(r: ClosureReport) {
    const merged = { ...r, files: report.files };
    const ok = await saveReport(merged);
    if (ok) setEditOpen(false);
  }

  // 직접 작성 Dialog 저장 (빈 폼에서 새로 작성)
  async function handleDialogSave(r: ClosureReport) {
    const ok = await saveReport(r);
    if (ok) setDialogOpen(false);
  }

  // ── Drive 업로드 ──
  async function uploadToDrive(file: File): Promise<{ driveFile: DriveFile; inMemoryText: string }> {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const CHUNK = 8192;
    const parts: string[] = [];
    for (let i = 0; i < bytes.byteLength; i += CHUNK) {
      parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
    }
    const base64 = btoa(parts.join(""));

    let inMemoryText = "";
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      try { inMemoryText = await extractPdfText(file); } catch { /* 스캔 PDF */ }
    }

    const { data: uploadResp, error: fnErr } = await supabase.functions.invoke("drive-proxy", {
      body: { name: file.name, mimeType: file.type || "application/octet-stream", data: base64, folderName: "종결보고" },
    });
    if (fnErr) throw new Error(fnErr.message);
    const up = uploadResp as { id?: string; url?: string; error?: string };
    if (up.error) throw new Error(up.error);
    if (!up.id || !up.url) throw new Error("Drive 업로드 실패");

    // 스캔 PDF라 pdfjs 텍스트가 없으면 Drive OCR 시도
    if (inMemoryText.trim().length < 20 && (file.type === "application/pdf" || /\.pdf$/i.test(file.name))) {
      try {
        const { data: ocrResp } = await supabase.functions.invoke("drive-proxy", {
          body: { action: "extractOcrText", fileId: up.id },
        });
        const ocrData = ocrResp as { text?: string; error?: string } | null;
        if (ocrData?.text && ocrData.text.trim().length >= 20) {
          inMemoryText = ocrData.text;
        }
      } catch { /* OCR 실패 무시 */ }
    }

    let extractedTextDriveId: string | undefined;
    if (inMemoryText.trim().length >= 20) {
      try {
        const textBase64 = btoa(unescape(encodeURIComponent(inMemoryText)));
        const { data: txtResp } = await supabase.functions.invoke("drive-proxy", {
          body: { name: file.name.replace(/\.pdf$/i, "") + "_text.txt", mimeType: "text/plain", data: textBase64, folderName: "종결보고" },
        });
        const td = txtResp as { id?: string; error?: string } | null;
        if (td && !td.error) extractedTextDriveId = td.id;
      } catch { /* txt 실패 무시 */ }
    }

    return {
      driveFile: { name: file.name, driveUrl: up.url, driveId: up.id, type: file.type, extractedTextDriveId },
      inMemoryText,
    };
  }

  async function fetchPdfText(f: DriveFile): Promise<string> {
    if (f.extractedTextDriveId) {
      const { data, error } = await supabase.functions.invoke("drive-proxy", {
        body: { action: "getFileText", fileId: f.extractedTextDriveId },
      });
      if (error) throw new Error(error.message);
      const r = data as { text?: string; error?: string };
      if (r.error) throw new Error(r.error);
      return r.text ?? "";
    }
    return "";
  }

  // ── PDF 선택 + AI 분석 ──
  async function handlePdfUpload(files: FileList) {
    const file = files[0];
    if (!file) return;
    setPdfBusy(true);
    const tid = toast.loading("파일 업로드 중...");
    try {
      const { driveFile, inMemoryText } = await uploadToDrive(file);
      const newFiles = [...report.files, driveFile];
      let patch: Partial<ClosureReport> = { files: newFiles };

      if (isAiBlocked(client)) {
        toast.info("AI 활용을 거부한 대상자라 AI 분석은 생략했습니다.");
      } else if (inMemoryText.trim().length >= 20) {
        toast.loading("AI 분석 중...", { id: tid });
        try {
          const result = await runAnalyze({ data: { text: inMemoryText, clientId: client.id } });
          patch = {
            ...patch,
            closure_date: result.closure_date || report.closure_date,
            case_status: Object.keys(result.case_status).length ? result.case_status : report.case_status,
            service_history: result.service_history.some((r) => r.date || r.content) ? result.service_history : report.service_history,
            closure_reason: result.closure_reason || report.closure_reason,
            worker_opinion: result.worker_opinion || report.worker_opinion,
            closure_type: result.closure_type || report.closure_type,
            closure_type_detail: result.closure_type_detail || report.closure_type_detail,
            closure_result: result.closure_result || report.closure_result,
            referral_org: result.referral_org || report.referral_org,
            written_by: result.written_by || report.written_by,
          };
        } catch (e) {
          toast.warning(aiErrMsg((e as Error).message || ""), { id: tid });
        }
      } else if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        toast.warning("PDF에서 텍스트를 추출하지 못했습니다. 직접 작성해 주세요.", { id: tid });
      }

      const merged = { ...report, ...patch };
      const hasAnalysis = !!(patch.closure_reason || patch.closure_date || patch.closure_type);
      if (hasAnalysis) {
        toast.dismiss(tid);
        setAiDraft(merged);
        setAiConfirmOpen(true);
      } else {
        await saveReport(merged, true);
        toast.success("파일 업로드 완료.", { id: tid });
      }
    } catch (e) {
      toast.error("업로드 실패: " + (e as Error).message, { id: tid });
    } finally {
      setPdfBusy(false);
    }
  }

  // ── AI 재분석 ──
  async function handleReAnalyze() {
    const pdf = report.files.find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    if (!pdf) { toast.error("첨부된 PDF 파일이 없어요."); return; }
    if (isAiBlocked(client)) { toast.error(AI_REFUSED_MESSAGE); return; }
    setAiBusy(true);
    try {
      let text = await fetchPdfText(pdf);

      // 저장된 텍스트가 없으면 Drive OCR로 직접 재시도
      if ((!text || text.trim().length < 20) && pdf.driveId) {
        toast.loading("스캔 PDF OCR 시도 중...", { id: "ocr" });
        try {
          const { data: ocrResp } = await supabase.functions.invoke("drive-proxy", {
            body: { action: "extractOcrText", fileId: pdf.driveId },
          });
          const ocrData = ocrResp as { text?: string; error?: string } | null;
          if (ocrData?.text && ocrData.text.trim().length >= 20) {
            text = ocrData.text;
          }
        } catch { /* OCR 실패 무시 */ } finally {
          toast.dismiss("ocr");
        }
      }

      if (!text || text.trim().length < 20) {
        toast.error("PDF 텍스트를 추출하지 못했어요. PDF를 다시 업로드해 주세요."); return;
      }
      const result = await runAnalyze({ data: { text, clientId: client.id } });
      const merged: ClosureReport = {
        ...report,
        closure_date: result.closure_date || report.closure_date,
        case_status: Object.keys(result.case_status).length ? result.case_status : report.case_status,
        service_history: result.service_history.some((r) => r.date || r.content) ? result.service_history : report.service_history,
        closure_reason: result.closure_reason || report.closure_reason,
        worker_opinion: result.worker_opinion || report.worker_opinion,
        closure_type: result.closure_type || report.closure_type,
        closure_type_detail: result.closure_type_detail || report.closure_type_detail,
        closure_result: result.closure_result || report.closure_result,
        referral_org: result.referral_org || report.referral_org,
        written_by: result.written_by || report.written_by,
      };
      setAiDraft(merged);
      setAiConfirmOpen(true);
    } catch (e) {
      toast.error(aiErrMsg((e as Error).message || ""));
    } finally {
      setAiBusy(false);
    }
  }

  // ── 파일 삭제 ──
  async function handleDeleteFile(idx: number) {
    const newFiles = report.files.filter((_, i) => i !== idx);
    const updated = { ...report, files: newFiles };
    await saveReport(updated, true);
    toast.success("파일이 삭제됐습니다.");
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> 불러오는 중…
      </div>
    );
  }

  const hasPdf = report.files.some((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  const hasAnalyzed = hasPdf && !!(report.closure_date || report.closure_reason || report.worker_opinion || report.closure_type);
  const hasContent = !!(report.closure_date || report.closure_reason || report.worker_opinion || report.closure_type || report.written_by || report.service_history.some((r) => r.date || r.content));

  return (
    <div className="space-y-3">
      {/* 상단 액션 바 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">서비스 종결 평가 보고서</span>
          {!isTerminated && (
            <Badge variant="secondary" className="text-xs">이전 종결 이력</Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* PDF 선택 */}
          <label className="text-sm inline-flex items-center gap-1 cursor-pointer rounded-md border border-border px-3 h-9 hover:bg-accent">
            {pdfBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            PDF 선택
            <input
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              disabled={pdfBusy || aiBusy}
              onChange={(e) => {
                if (e.target.files?.length) handlePdfUpload(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          {/* AI 재분석 */}
          {hasPdf && (
            <Button size="sm" variant="outline" onClick={handleReAnalyze} disabled={aiBusy || pdfBusy}>
              {aiBusy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Sparkles className="h-4 w-4 mr-1" />}
              {hasAnalyzed ? "AI 재분석" : "AI 분석"}
            </Button>
          )}
          {hasPdf && <AiModelBadge />}
          {/* 수정 (기존 내용이 있을 때만) */}
          {hasContent && (
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)} disabled={pdfBusy || aiBusy}>
              <Pencil className="h-4 w-4 mr-1" />
              수정
            </Button>
          )}
          {/* 직접 작성 (새 보고서 작성) */}
          <Button size="sm" onClick={() => setDialogOpen(true)} disabled={pdfBusy || aiBusy}>
            <Plus className="h-4 w-4 mr-1" />
            직접 작성
          </Button>
        </div>
      </div>

      {/* 읽기 전용 뷰 */}
      <ClosureReportView report={report} onDeleteFile={handleDeleteFile} />

      {/* 수정 Dialog (기존 내용 pre-filled) */}
      <ClosureFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        initial={report}
        onSave={handleEditSave}
        title="종결보고서 수정"
      />

      {/* 직접 작성 Dialog (빈 폼으로 새로 작성) */}
      <ClosureFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={EMPTY}
        onSave={handleDialogSave}
        title="종결보고서 직접 작성"
      />

      {/* AI 분석 결과 확인 Dialog */}
      {aiDraft && (
        <Dialog open={aiConfirmOpen} onOpenChange={setAiConfirmOpen}>
          <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>AI 분석 결과 확인</DialogTitle>
              <DialogDescription>
                아래 내용을 확인하고 저장하세요. [직접 작성]에서 수정할 수 있습니다.
              </DialogDescription>
            </DialogHeader>
            <ClosureReportView report={aiDraft} />
            <DialogFooter>
              <Button variant="outline" onClick={() => setAiConfirmOpen(false)}>취소</Button>
              <Button
                onClick={async () => {
                  setAiConfirmOpen(false);
                  await saveReport(aiDraft, false);
                  setAiDraft(null);
                }}
              >
                <Save className="h-4 w-4 mr-1" />
                저장
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
