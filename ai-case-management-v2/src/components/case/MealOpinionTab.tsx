import { openDriveFile } from "@/lib/drive-viewer";
/**
 * MealOpinionTab — 무료급식 대상자 종합의견 탭
 *
 * 흐름 (SideDishTab과 동일):
 *   1) [PDF 선택] → 텍스트 추출 + Google Drive 업로드 (동시)
 *   2) [AI 분석] → Gemini가 조사 내용 추출
 *   3) 다이얼로그에서 검토·수정 → [저장]
 */
import { useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AiModelBadge } from "@/components/AiModelBadge";
import { useServerFn } from "@tanstack/react-start";
import { analyzeMealOpinion } from "@/lib/ai.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
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
  Upload, Loader2, Plus, FileText, Trash2,
  Sparkles, X, ExternalLink, ChevronDown,
  Heart, Utensils, Home, ClipboardList,
  AlertTriangle, Users, CheckSquare,
} from "lucide-react";
import { extractPdfText, aiErrorMsg, uploadFileToDrive } from "@/lib/pdf-utils";
import {
  splitNote,
  joinNote,
  type Client,
  type MealOpinionRecord,
} from "@/lib/case-types";

const OPINION_FOLDER = "무료급식 종합의견";

function emptyRecord(id: string): MealOpinionRecord {
  return {
    id,
    recordedAt: "",
    livingCondition: "",
    healthCondition: "",
    mealCondition: "",
    specialNotes: "",
    workerOpinion: "",
    selectionContent: "",
    uploadedAt: new Date().toISOString(),
  };
}

type Props = { client: Client; onChanged: () => void };
type AddStep = "idle" | "loading" | "ready" | "analyzing" | "edit";

function buildMergedRecord(
  result: {
    recordedAt?: string; livingCondition?: string; healthCondition?: string;
    mealCondition?: string; specialNotes?: string; workerOpinion?: string;
    selectionContent?: string;
  },
  base: MealOpinionRecord,
  driveFile: { name: string; driveUrl: string; driveId: string } | null,
): MealOpinionRecord {
  return {
    ...base,
    recordedAt: result.recordedAt ?? base.recordedAt,
    livingCondition: result.livingCondition ?? base.livingCondition,
    healthCondition: result.healthCondition ?? base.healthCondition,
    mealCondition: result.mealCondition ?? base.mealCondition,
    specialNotes: result.specialNotes ?? base.specialNotes,
    workerOpinion: result.workerOpinion ?? base.workerOpinion,
    selectionContent: result.selectionContent ?? base.selectionContent,
    ...(driveFile
      ? { fileName: driveFile.name, driveUrl: driveFile.driveUrl, driveId: driveFile.driveId }
      : {}),
  };
}

// ── 수정 다이얼로그 ───────────────────────────────────────────────────
function EditDialog({
  open, onOpenChange, record: init, onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  record: MealOpinionRecord;
  onSave: (r: MealOpinionRecord) => Promise<void>;
}) {
  const [form, setForm] = useState<MealOpinionRecord>(init);
  const [saving, setSaving] = useState(false);

  function upd<K extends keyof MealOpinionRecord>(key: K, val: MealOpinionRecord[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  async function handleConfirm() {
    setSaving(true);
    try { await onSave(form); onOpenChange(false); }
    catch (e) { toast.error("저장 실패: " + (e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>종합의견 검토 · 수정</DialogTitle>
          <DialogDescription>AI 분석 결과를 확인하고 필요 시 수정 후 저장하세요.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* 기록일 */}
          <div className="flex items-center gap-3">
            <Label className="text-xs shrink-0 w-16">기록일</Label>
            <Input
              type="date"
              value={form.recordedAt}
              onChange={(e) => upd("recordedAt", e.target.value)}
              className="flex-1"
            />
          </div>

          {/* Drive 파일 링크 */}
          {form.driveUrl && (
            <a
              href={form.driveUrl}
              onClick={(e) => { e.preventDefault(); openDriveFile(form.driveUrl, form.fileName ?? "종합의견 PDF", { kind: "급식 종합의견 PDF" }); }}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {form.fileName ?? "PDF 파일"} — Google Drive
            </a>
          )}

          {/* 실태 현황 */}
          <div>
            <div className="flex items-center gap-1 text-xs font-semibold text-primary mb-2">
              <ClipboardList className="h-3.5 w-3.5" /> 실태 현황
            </div>
            <div className="grid grid-cols-1 gap-3">
              {[
                { key: "livingCondition" as const, label: "생활 실태", icon: <Home className="h-3 w-3" /> },
                { key: "healthCondition" as const, label: "건강 실태", icon: <Heart className="h-3 w-3" /> },
                { key: "mealCondition"   as const, label: "급식 실태", icon: <Utensils className="h-3 w-3" /> },
              ].map(({ key, label, icon }) => (
                <div key={key}>
                  <Label className="text-[11px] text-muted-foreground flex items-center gap-0.5 mb-1">
                    {icon} {label}
                  </Label>
                  <Textarea
                    rows={3}
                    value={(form[key] as string) ?? ""}
                    onChange={(e) => upd(key, e.target.value)}
                    className="text-sm resize-none"
                    placeholder={`${label} 내용`}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* 특이사항 */}
          <div>
            <div className="flex items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-400 mb-2">
              <AlertTriangle className="h-3.5 w-3.5" /> 특이사항
            </div>
            <Textarea
              rows={3}
              value={form.specialNotes ?? ""}
              onChange={(e) => upd("specialNotes", e.target.value)}
              className="text-sm resize-none"
              placeholder="특이사항 내용"
            />
          </div>

          {/* 사회복지사 종합의견 */}
          <div>
            <div className="flex items-center gap-1 text-xs font-semibold text-primary mb-2">
              <Users className="h-3.5 w-3.5" /> 사회복지사 종합의견
            </div>
            <Textarea
              rows={4}
              value={form.workerOpinion ?? ""}
              onChange={(e) => upd("workerOpinion", e.target.value)}
              className="text-sm resize-none"
              placeholder="사회복지사 종합의견"
            />
          </div>

          {/* 선정 내용 */}
          <div>
            <div className="flex items-center gap-1 text-xs font-semibold text-primary mb-2">
              <CheckSquare className="h-3.5 w-3.5" /> 선정 내용
            </div>
            <Textarea
              rows={3}
              value={form.selectionContent ?? ""}
              onChange={(e) => upd("selectionContent", e.target.value)}
              className="text-sm resize-none"
              placeholder="선정 내용"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>취소</Button>
          <Button onClick={handleConfirm} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── 개별 기록 카드 (SideDishTab AssessmentCard 스타일) ────────────────
function OpinionCard({
  record,
  onEdit,
  onDelete,
  onReanalyze,
  isReanalyzing,
  initialOpen = false,
}: {
  record: MealOpinionRecord;
  onEdit: () => void;
  onDelete: () => void;
  onReanalyze: (file: File) => void;
  isReanalyzing: boolean;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const reanalRef = useRef<HTMLInputElement>(null);

  const condSections = [
    { label: "생활 실태", icon: <Home className="h-3.5 w-3.5" />,     value: record.livingCondition ?? "" },
    { label: "건강 실태", icon: <Heart className="h-3.5 w-3.5" />,    value: record.healthCondition ?? "" },
    { label: "급식 실태", icon: <Utensils className="h-3.5 w-3.5" />, value: record.mealCondition ?? "" },
  ].filter((s) => s.value.trim());

  return (
    <div className="rounded-md border border-border">
      {/* 숨긴 파일 입력 (재분석용) */}
      <input
        ref={reanalRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onReanalyze(f);
          e.target.value = "";
        }}
      />

      {/* 헤더 */}
      <div
        className="flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-muted/40 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <ChevronDown className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
          <span className="text-sm font-medium truncate">
            종합의견 · {record.recordedAt || "날짜 미입력"}
          </span>
          {record.driveUrl && (
            <Badge variant="outline" className="text-[10px] shrink-0">PDF</Badge>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {/* PDF 재분석 */}
          <Button
            size="icon" variant="ghost" className="h-7 w-7"
            title="PDF로 재분석" disabled={isReanalyzing}
            onClick={() => reanalRef.current?.click()}
          >
            {isReanalyzing
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Sparkles className="h-3.5 w-3.5" />}
          </Button>

          {/* 수정 */}
          <Button
            size="icon" variant="ghost" className="h-7 w-7"
            title="수정" onClick={onEdit}
          >
            <FileText className="h-3.5 w-3.5" />
          </Button>

          {/* Drive 링크 */}
          {record.driveUrl && (
            <a href={record.driveUrl} onClick={(e) => { e.preventDefault(); openDriveFile(record.driveUrl, "종합의견 PDF", { kind: "급식 종합의견 PDF" }); }} target="_blank" rel="noopener noreferrer" title="Drive에서 열기">
              <Button size="icon" variant="ghost" className="h-7 w-7">
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </a>
          )}

          {/* 삭제 */}
          <Button
            size="icon" variant="ghost"
            className="h-7 w-7 text-destructive hover:text-destructive"
            title="삭제" onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 펼침 콘텐츠 */}
      {open && (
        <div className="border-t border-border px-3 pb-3 pt-2.5 space-y-2.5">
          {/* 특이사항 — 경고 박스 */}
          {(record.specialNotes ?? "").trim() && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 p-2.5">
              <div className="flex items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-400 mb-0.5">
                <AlertTriangle className="h-3.5 w-3.5" /> 특이사항
              </div>
              <p className="text-xs whitespace-pre-wrap leading-relaxed">{record.specialNotes}</p>
            </div>
          )}

          {/* 실태 3종 그리드 */}
          {condSections.length > 0 && (
            <div className={`grid gap-2 ${condSections.length === 3 ? "grid-cols-1 sm:grid-cols-3" : condSections.length === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
              {condSections.map((s) => (
                <div key={s.label} className="rounded-md border border-border bg-muted/30 p-2.5">
                  <div className="flex items-center gap-1 text-[11px] font-semibold text-primary mb-1">
                    {s.icon} {s.label}
                  </div>
                  <p className="text-xs whitespace-pre-wrap leading-relaxed">{s.value}</p>
                </div>
              ))}
            </div>
          )}

          {/* 사회복지사 종합의견 */}
          {(record.workerOpinion ?? "").trim() && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5">
              <div className="text-[11px] font-semibold text-primary mb-0.5">사회복지사 종합의견</div>
              <p className="text-xs whitespace-pre-wrap leading-relaxed">{record.workerOpinion}</p>
            </div>
          )}

          {/* 선정 내용 */}
          {(record.selectionContent ?? "").trim() && (
            <details className="group">
              <summary className="text-[11px] font-semibold text-primary cursor-pointer select-none list-none flex items-center gap-1 pb-1.5">
                <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                선정 내용 펼쳐보기
              </summary>
              <div className="px-2.5 pb-2.5">
                <div className="rounded border border-border p-2">
                  <p className="text-xs whitespace-pre-wrap leading-relaxed">{record.selectionContent}</p>
                </div>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────
export function MealOpinionTab({ client, onChanged }: Props) {
  const callAnalyze = useServerFn(analyzeMealOpinion);
  const { mealOpinion: records } = splitNote(client.note);
  const sorted = [...records].sort((a, b) =>
    (b.recordedAt || "").localeCompare(a.recordedAt || ""),
  );

  const [addStep, setAddStep] = useState<AddStep>("idle");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pdfText, setPdfText] = useState<string>("");
  const [driveFile, setDriveFile] = useState<{ name: string; driveUrl: string; driveId: string } | null>(null);
  const [loadingMsg, setLoadingMsg] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [editRecord, setEditRecord] = useState<MealOpinionRecord | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editDialogKey, setEditDialogKey] = useState(0);
  const [reanalyzingIds, setReanalyzingIds] = useState<Set<string>>(new Set());

  function resetUpload() {
    setSelectedFile(null); setPdfText(""); setDriveFile(null); setLoadingMsg("");
    setAddStep("idle");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFileSelect(file: File) {
    setSelectedFile(file);
    setAddStep("loading");
    setLoadingMsg("PDF 읽는 중…");
    try {
      const [text, driveResult] = await Promise.allSettled([
        extractPdfText(file),
        (async () => {
          setLoadingMsg("Google Drive에 저장 중…");
          return await uploadFileToDrive(supabase, file, OPINION_FOLDER);
        })(),
      ]);

      const extractedText = text.status === "fulfilled" && text.value.trim() ? text.value : "";
      if (!extractedText) {
        toast.error("PDF에서 텍스트를 추출할 수 없습니다. 스캔 이미지 PDF는 지원되지 않습니다.");
        resetUpload(); return;
      }
      setPdfText(extractedText);

      if (driveResult.status === "fulfilled") {
        setDriveFile({ name: file.name, driveUrl: driveResult.value.url, driveId: driveResult.value.id });
        toast.success("Google Drive에 저장됐습니다.");
      } else {
        console.warn("Drive 업로드 실패:", driveResult.reason);
        toast.warning("Drive 저장에 실패했어요. AI 분석은 계속 진행 가능합니다.");
        setDriveFile(null);
      }
      setLoadingMsg(""); setAddStep("ready");
    } catch (e) {
      toast.error("파일 처리 중 오류: " + (e as Error).message);
      resetUpload();
    }
  }

  async function handleAnalyze() {
    if (!pdfText.trim()) return;
    if (isAiBlocked(client)) { toast.error(AI_REFUSED_MESSAGE); return; }
    setAddStep("analyzing");
    try {
      const result = await callAnalyze({ data: { text: pdfText, clientId: client.id } });
      if (!result.ok) { toast.error(result.error || "AI 분석에 실패했습니다."); setAddStep("ready"); return; }
      const rec = buildMergedRecord(result, emptyRecord(crypto.randomUUID()), driveFile);
      setEditRecord(rec); setAddStep("edit");
      setEditDialogKey((k) => k + 1);
      setEditDialogOpen(true);
    } catch (e) {
      toast.error(aiErrorMsg((e as Error).message)); setAddStep("ready");
    }
  }

  async function saveRecord(record: MealOpinionRecord) {
    const cur = splitNote(client.note);
    const next = cur.mealOpinion.some((r) => r.id === record.id)
      ? cur.mealOpinion.map((r) => (r.id === record.id ? record : r))
      : [...cur.mealOpinion, record];
    const newNote = joinNote(cur.note, cur.reassessments, cur.goalAnalysis, cur.closeReason, cur.sideDishAssessments, next, cur.familyMembers);
    const { error } = await supabase.from("clients").update({ note: newNote }).eq("id", client.id);
    if (error) throw new Error(error.message);
    toast.success("종합의견이 저장됐습니다.");
    resetUpload(); onChanged();
  }

  async function handleReanalyzeFile(record: MealOpinionRecord, file: File) {
    if (isAiBlocked(client)) { toast.error(AI_REFUSED_MESSAGE); return; }
    setReanalyzingIds((ids) => new Set([...ids, record.id]));
    try {
      const [textResult, driveResult] = await Promise.allSettled([
        extractPdfText(file),
        uploadFileToDrive(supabase, file, OPINION_FOLDER),
      ]);
      const text = textResult.status === "fulfilled" ? textResult.value.trim() : "";
      if (!text) { toast.error("PDF에서 텍스트를 추출할 수 없습니다."); return; }

      let newDrive: { name: string; driveUrl: string; driveId: string } | null = null;
      if (driveResult.status === "fulfilled") {
        newDrive = { name: file.name, driveUrl: driveResult.value.url, driveId: driveResult.value.id };
        toast.success("Google Drive에 저장됐습니다.");
      } else {
        toast.warning("Drive 저장 실패. AI 분석은 계속 진행합니다.");
      }

      const result = await callAnalyze({ data: { text, clientId: client.id } });
      if (!result.ok) { toast.error(result.error || "AI 분석에 실패했습니다."); return; }

      const updated = buildMergedRecord(result, record, newDrive);
      setEditRecord(updated);
      setEditDialogKey((k) => k + 1);
      setEditDialogOpen(true);
    } catch (e) {
      toast.error(aiErrorMsg((e as Error).message));
    } finally {
      setReanalyzingIds((ids) => { const n = new Set(ids); n.delete(record.id); return n; });
    }
  }

  async function deleteRecord(id: string) {
    if (!confirm("이 종합의견 기록을 삭제하시겠습니까?")) return;
    const cur = splitNote(client.note);
    const next = cur.mealOpinion.filter((r) => r.id !== id);
    const newNote = joinNote(cur.note, cur.reassessments, cur.goalAnalysis, cur.closeReason, cur.sideDishAssessments, next, cur.familyMembers);
    const { error } = await supabase.from("clients").update({ note: newNote }).eq("id", client.id);
    if (error) { toast.error(error.message); return; }
    toast.success("삭제됐습니다."); onChanged();
  }

  const isBusy = addStep === "loading" || addStep === "analyzing";

  return (
    <div className="space-y-3">
      {/* 헤더 */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          무료급식 종합의견 · PDF 선택 시 Drive 자동 저장 후 AI 분석
          <AiModelBadge className="ml-2" />
        </p>
        <div className="flex gap-2">
          {/* 직접 입력 */}
          <Button
            size="sm" variant="outline" disabled={isBusy}
            onClick={() => {
              setEditRecord(emptyRecord(crypto.randomUUID()));
              setEditDialogKey((k) => k + 1);
              setEditDialogOpen(true);
            }}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />직접 입력
          </Button>

          {/* PDF 선택 */}
          <label className="cursor-pointer">
            <Button size="sm" variant="outline" asChild disabled={isBusy}>
              <span><Upload className="h-3.5 w-3.5 mr-1" />PDF 선택</span>
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              className="hidden"
              disabled={isBusy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileSelect(f);
                e.currentTarget.value = "";
              }}
            />
          </label>
        </div>
      </div>

      {/* PDF 처리 진행 상태 */}
      {addStep !== "idle" && addStep !== "edit" && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 flex items-center gap-3">
          {isBusy && <Loader2 className="h-4 w-4 animate-spin shrink-0 text-primary" />}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{selectedFile?.name}</p>
            <p className="text-xs text-muted-foreground">{loadingMsg || (addStep === "ready" ? "준비됨" : "")}</p>
          </div>
          {addStep === "ready" && (
            <Button size="sm" onClick={handleAnalyze} className="shrink-0">
              <Sparkles className="h-3.5 w-3.5 mr-1" />AI 분석
            </Button>
          )}
          <button
            type="button"
            onClick={resetUpload}
            disabled={isBusy}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 기록 목록 */}
      {sorted.length === 0 ? (
        <div className="rounded-md border border-dashed border-border py-10 flex flex-col items-center gap-2 text-muted-foreground">
          <FileText className="h-8 w-8 opacity-40" />
          <p className="text-sm">종합의견 기록이 없습니다.</p>
          <p className="text-xs">PDF를 업로드하거나 직접 입력하세요.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((rec, idx) => (
            <OpinionCard
              key={rec.id}
              record={rec}
              initialOpen={idx === 0}
              isReanalyzing={reanalyzingIds.has(rec.id)}
              onEdit={() => {
                setEditRecord(rec);
                setEditDialogKey((k) => k + 1);
                setEditDialogOpen(true);
              }}
              onDelete={() => deleteRecord(rec.id)}
              onReanalyze={(file) => handleReanalyzeFile(rec, file)}
            />
          ))}
        </div>
      )}

      {/* 수정 다이얼로그 */}
      {editRecord && (
        <EditDialog
          key={editDialogKey}
          open={editDialogOpen}
          onOpenChange={(v) => {
            setEditDialogOpen(v);
            if (!v) { setEditRecord(null); if (addStep === "edit") resetUpload(); }
          }}
          record={editRecord}
          onSave={saveRecord}
        />
      )}
    </div>
  );
}
