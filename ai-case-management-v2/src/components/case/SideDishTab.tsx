import { openDriveFile } from "@/lib/drive-viewer";
/**
 * SideDishTab — 밑반찬 대상자용 실태조사 탭
 *
 * 흐름:
 *   1) [PDF 선택] → 파일명 표시 + 텍스트 추출 + Google Drive 업로드 (동시 진행)
 *   2) [AI 분석] 클릭 → Gemini가 조사 내용·조사일 추출
 *   3) 다이얼로그에서 검토·수정 → [저장]
 */
import { useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AiModelBadge } from "@/components/AiModelBadge";
import { useServerFn } from "@tanstack/react-start";
import { analyzeSideDishAssessment } from "@/lib/ai.functions";
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
  AlertTriangle, Heart, Utensils, Home, ClipboardList,
  Users, CheckSquare, Pencil,
} from "lucide-react";
import { extractPdfText, aiErrorMsg, uploadFileToDrive } from "@/lib/pdf-utils";
import {
  splitNote,
  joinNote,
  type Client,
  type SideDishAssessment,
  type SideDishAssessmentFile,
} from "@/lib/case-types";

const ASSESSMENT_FOLDER = "밑반찬 실태조사";

function emptyAssessment(id: string): SideDishAssessment {
  return {
    id, assessedAt: "",
    livingCondition: "", healthCondition: "", mealCondition: "",
    specialNotes: "", workerOpinion: "",
    selectionContent: "", selectionResult: "",
    meetingContent: "", meetingDecision: "",
    uploadedAt: new Date().toISOString(),
  };
}

type Props = { client: Client; onChanged: () => void };
type AddStep = "idle" | "loading" | "ready" | "analyzing" | "edit";

// ── AI 결과로 record 병합 ─────────────────────────────────────────────
// Fix #5+#9: || 대신 ??를 써서 AI가 "" 반환 시 기존 값을 유지하지 않도록 함
// 두 분석 흐름(신규/재분석)에서 공통으로 사용하는 helper
function buildMergedRecord(
  result: {
    assessedAt?: string; livingCondition?: string; healthCondition?: string;
    mealCondition?: string; specialNotes?: string; workerOpinion?: string;
    selectionContent?: string; selectionResult?: string;
    meetingContent?: string; meetingDecision?: string;
  },
  base: SideDishAssessment,
  driveFile: SideDishAssessmentFile | null,
): SideDishAssessment {
  return {
    ...base,
    assessedAt: result.assessedAt ?? base.assessedAt,
    livingCondition: result.livingCondition ?? base.livingCondition,
    healthCondition: result.healthCondition ?? base.healthCondition,
    mealCondition: result.mealCondition ?? base.mealCondition,
    specialNotes: result.specialNotes ?? base.specialNotes,
    workerOpinion: result.workerOpinion ?? base.workerOpinion,
    selectionContent: result.selectionContent ?? base.selectionContent,
    selectionResult: result.selectionResult ?? base.selectionResult,
    meetingContent: result.meetingContent ?? base.meetingContent,
    meetingDecision: result.meetingDecision ?? base.meetingDecision,
    // driveFile 있으면 맨 앞에 추가(중복 제거), 없으면 기존 files 유지
    files: driveFile
      ? [driveFile, ...(base.files ?? []).filter((f) => f.driveId !== driveFile.driveId)]
      : base.files ?? [],
  };
}

// ── 선정 결과 배지 색상 ────────────────────────────────────────────────
function selectionBadge(result: string) {
  if (!result.trim()) return null;
  const isOk = /선정|승인|적격/.test(result);
  const isNo = /미선정|부적격|거부/.test(result);
  const cls = isOk
    ? "border-green-400 text-green-700 bg-green-50"
    : isNo
      ? "border-red-400 text-red-600 bg-red-50"
      : "border-amber-400 text-amber-700 bg-amber-50";
  return <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${cls}`}>{result}</Badge>;
}

// ── 실태조사 카드 (목록 표시) ─────────────────────────────────────────
function AssessmentCard({
  record,
  onDelete,
  onEdit,
  onReanalyzeFile,
  isReanalyzing,
  initialOpen = false,
}: {
  record: SideDishAssessment;
  onDelete: () => void;
  onEdit: () => void;
  onReanalyzeFile: (file: File) => void;
  isReanalyzing?: boolean;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const reanalyzeInputRef = useRef<HTMLInputElement>(null);
  const pdfFile = record.files?.find((f) => f.driveUrl);

  const condSections = [
    { label: "생활 실태", value: record.livingCondition, icon: <Home className="h-3.5 w-3.5" /> },
    { label: "건강 실태", value: record.healthCondition, icon: <Heart className="h-3.5 w-3.5" /> },
    { label: "급식 실태", value: record.mealCondition, icon: <Utensils className="h-3.5 w-3.5" /> },
  ].filter((s) => s.value.trim());

  // Fix #3: workerOpinion은 아래 별도 블록에서 렌더링하므로 여기서 제외
  const otherSections = [
    { label: "선정조사표 내용", value: record.selectionContent },
    { label: "사례회의록 내용", value: record.meetingContent },
    { label: "결정사항", value: record.meetingDecision },
  ].filter((s) => s.value.trim());

  return (
    <div className="rounded-md border border-border">
      {/* 숨긴 파일 입력 (AI 재분석용) */}
      <input
        ref={reanalyzeInputRef}
        type="file"
        accept=".pdf"
        className="hidden"
        disabled={isReanalyzing}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) { onReanalyzeFile(f); e.target.value = ""; }
        }}
      />

      {/* 헤더 — 항상 표시 */}
      <div
        className="flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-muted/40 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <ChevronDown className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
          <span className="text-sm font-medium shrink-0">
            실태조사 · {record.assessedAt || "날짜 미상"}
          </span>
          {record.selectionResult && selectionBadge(record.selectionResult)}
          {pdfFile?.driveUrl && (
            <a
              href={pdfFile.driveUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); openDriveFile(pdfFile.driveUrl, "원본 PDF", { kind: "밑반찬 원본 PDF" }); }}
              className="flex items-center gap-0.5 text-[10px] text-primary hover:underline shrink-0"
              title="원본 PDF 열기"
            >
              <ExternalLink className="h-3 w-3" />PDF
            </a>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* 수정 버튼 */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-1 rounded hover:bg-muted"
            title="내용 수정"
          >
            <Pencil className="h-3 w-3" />
            수정
          </button>
          {/* AI 재분석 버튼 */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); reanalyzeInputRef.current?.click(); }}
            disabled={isReanalyzing}
            className="flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80 disabled:opacity-40 transition-colors px-1.5 py-1 rounded hover:bg-primary/10"
            title="PDF를 다시 선택해 AI 재분석"
          >
            {isReanalyzing
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <Sparkles className="h-3 w-3" />}
            AI 재분석
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="text-muted-foreground hover:text-destructive transition-colors p-1 shrink-0"
            title="삭제"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 펼침 콘텐츠 */}
      {open && (
        <div className="border-t border-border px-3 pb-3 pt-2.5 space-y-2.5">
          {/* 특이사항 — 경고 박스 */}
          {record.specialNotes.trim() && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 p-2.5">
              <div className="flex items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-400 mb-0.5">
                <AlertTriangle className="h-3.5 w-3.5" /> 특이사항
              </div>
              <p className="text-sm text-amber-900 dark:text-amber-200 whitespace-pre-wrap leading-relaxed">
                {record.specialNotes}
              </p>
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

          {/* 사회복지사 의견 */}
          {record.workerOpinion.trim() && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5">
              <div className="text-[11px] font-semibold text-primary mb-0.5">사회복지사 의견</div>
              <p className="text-xs whitespace-pre-wrap leading-relaxed">{record.workerOpinion}</p>
            </div>
          )}

          {/* 선정·회의 기타 — 기본 접힘 */}
          {otherSections.length > 0 && (
            <details className="group rounded-md border border-border bg-background">
              <summary className="flex items-center gap-1 cursor-pointer px-2.5 py-2 text-xs font-medium text-muted-foreground list-none">
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                선정조사표 · 사례회의록 펼쳐보기
              </summary>
              <div className="px-2.5 pb-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {otherSections.map((s) => (
                  <div key={s.label} className="rounded border border-border p-2">
                    <div className="text-[11px] font-semibold text-primary mb-0.5">{s.label}</div>
                    <p className="text-xs whitespace-pre-wrap leading-relaxed">{s.value}</p>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ── 실태조사 편집 다이얼로그 ──────────────────────────────────────────
// Fix #10: lastInitId render-phase guard 제거 — 부모가 key를 변경해 강제 리마운트
function AddDialog({
  open: dialogOpen,
  onOpenChange,
  initial,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial: SideDishAssessment;
  onConfirm: (record: SideDishAssessment) => Promise<void>;
}) {
  const [form, setForm] = useState<SideDishAssessment>(initial);
  const [saving, setSaving] = useState(false);

  function upd(k: keyof SideDishAssessment, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function handleConfirm() {
    setSaving(true);
    try { await onConfirm(form); onOpenChange(false); }
    catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  }

  const pdfUrl = form.files?.[0]?.driveUrl;

  return (
    <Dialog open={dialogOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-primary" />
            실태조사 내용 확인
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            AI가 추출한 내용을 검토하고 수정한 뒤 저장하세요.
            <AiModelBadge />
            {pdfUrl && (
              <a href={pdfUrl} onClick={(e) => { e.preventDefault(); openDriveFile(pdfUrl, "원본 PDF", { kind: "밑반찬 원본 PDF" }); }} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-primary hover:underline text-xs">
                <ExternalLink className="h-3 w-3" />원본 PDF
              </a>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* 조사일 */}
          <div className="flex items-center gap-3">
            <Label className="text-xs shrink-0 w-16">조사일</Label>
            <Input type="date" value={form.assessedAt} onChange={(e) => upd("assessedAt", e.target.value)} className="flex-1" />
          </div>

          {/* 실태 3종 */}
          <div>
            <div className="flex items-center gap-1 text-xs font-semibold text-primary mb-2">
              <ClipboardList className="h-3.5 w-3.5" /> 실태 현황
            </div>
            <div className="grid grid-cols-1 gap-3">
              {[
                { key: "livingCondition" as const, label: "생활 실태", icon: <Home className="h-3 w-3" /> },
                { key: "healthCondition" as const, label: "건강 실태", icon: <Heart className="h-3 w-3" /> },
                { key: "mealCondition" as const, label: "급식 실태", icon: <Utensils className="h-3 w-3" /> },
              ].map(({ key, label, icon }) => (
                <div key={key}>
                  <Label className="text-[11px] text-muted-foreground flex items-center gap-0.5 mb-1">
                    {icon} {label}
                  </Label>
                  <Textarea rows={2} value={form[key]} onChange={(e) => upd(key, e.target.value)} className="text-sm" />
                </div>
              ))}
            </div>
          </div>

          {/* 특이사항 */}
          <div>
            <div className="flex items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-400 mb-2">
              <AlertTriangle className="h-3.5 w-3.5" /> 특이사항
            </div>
            <Textarea rows={2} value={form.specialNotes} onChange={(e) => upd("specialNotes", e.target.value)} className="text-sm border-amber-300 focus-visible:ring-amber-400" />
          </div>

          {/* 사회복지사 의견 */}
          <div>
            <div className="flex items-center gap-1 text-xs font-semibold text-primary mb-2">
              <Users className="h-3.5 w-3.5" /> 사회복지사 의견
            </div>
            <Textarea rows={3} value={form.workerOpinion} onChange={(e) => upd("workerOpinion", e.target.value)} className="text-sm" />
          </div>

          {/* 선정 정보 */}
          <div>
            <div className="flex items-center gap-1 text-xs font-semibold text-primary mb-2">
              <CheckSquare className="h-3.5 w-3.5" /> 선정 정보
            </div>
            <div className="grid grid-cols-1 gap-3">
              <div>
                <Label className="text-[11px] text-muted-foreground mb-1 block">선정조사표 내용</Label>
                <Textarea rows={3} value={form.selectionContent} onChange={(e) => upd("selectionContent", e.target.value)} className="text-sm" />
              </div>
              <div>
                <Label className="text-[11px] text-muted-foreground mb-1 block">선정 결과</Label>
                <Input value={form.selectionResult} onChange={(e) => upd("selectionResult", e.target.value)} className="text-sm" placeholder="예) 선정, 미선정, 보류" />
              </div>
            </div>
          </div>

          {/* 사례회의 */}
          <div>
            <div className="flex items-center gap-1 text-xs font-semibold text-primary mb-2">
              <Users className="h-3.5 w-3.5" /> 사례회의록
            </div>
            <div className="grid grid-cols-1 gap-3">
              <div>
                <Label className="text-[11px] text-muted-foreground mb-1 block">회의 내용</Label>
                <Textarea rows={3} value={form.meetingContent} onChange={(e) => upd("meetingContent", e.target.value)} className="text-sm" />
              </div>
              <div>
                <Label className="text-[11px] text-muted-foreground mb-1 block">결정사항</Label>
                <Textarea rows={2} value={form.meetingDecision} onChange={(e) => upd("meetingDecision", e.target.value)} className="text-sm" />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>취소</Button>
          <Button onClick={handleConfirm} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────
export function SideDishTab({ client, onChanged }: Props) {
  const callAnalyze = useServerFn(analyzeSideDishAssessment);
  const { sideDishAssessments } = splitNote(client.note);
  const sorted = [...sideDishAssessments].sort((a, b) =>
    (b.assessedAt || "").localeCompare(a.assessedAt || ""),
  );

  const [addStep, setAddStep] = useState<AddStep>("idle");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pdfText, setPdfText] = useState<string>("");
  const [driveFile, setDriveFile] = useState<SideDishAssessmentFile | null>(null);
  const [loadingMsg, setLoadingMsg] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [editRecord, setEditRecord] = useState<SideDishAssessment | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  // Fix #10: key 변경으로 AddDialog 강제 리마운트 → 같은 id 재분석 시에도 form 갱신
  const [editDialogKey, setEditDialogKey] = useState(0);
  // Fix #6: Set으로 관리해 복수 동시 재분석 지원
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
          return await uploadFileToDrive(supabase, file, ASSESSMENT_FOLDER);
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
      // Fix #9: buildMergedRecord 공통 helper 사용
      const rec = buildMergedRecord(result, { ...emptyAssessment(crypto.randomUUID()), files: [] }, driveFile);
      setEditRecord(rec); setAddStep("edit");
      setEditDialogKey((k) => k + 1); // Fix #10: 강제 리마운트
      setEditDialogOpen(true);
    } catch (e) {
      toast.error(aiErrorMsg((e as Error).message)); setAddStep("ready");
    }
  }

  async function saveRecord(record: SideDishAssessment) {
    const cur = splitNote(client.note);
    const next = cur.sideDishAssessments.some((s) => s.id === record.id)
      ? cur.sideDishAssessments.map((s) => (s.id === record.id ? record : s))
      : [...cur.sideDishAssessments, record];
    const newNote = joinNote(cur.note, cur.reassessments, cur.goalAnalysis, cur.closeReason, next, cur.mealOpinion, cur.familyMembers);
    const { error } = await supabase.from("clients").update({ note: newNote }).eq("id", client.id);
    if (error) throw new Error(error.message);
    toast.success("실태조사가 저장됐습니다.");
    resetUpload(); onChanged();
  }

  // Fix #6: Set으로 복수 재분석 지원 / Fix #5: ?? 사용 / Fix #9: buildMergedRecord 사용
  async function handleReanalyzeFile(record: SideDishAssessment, file: File) {
    if (isAiBlocked(client)) { toast.error(AI_REFUSED_MESSAGE); return; }
    setReanalyzingIds((ids) => new Set([...ids, record.id]));
    try {
      const [textResult, driveResult] = await Promise.allSettled([
        extractPdfText(file),
        uploadFileToDrive(supabase, file, ASSESSMENT_FOLDER),
      ]);

      const text = textResult.status === "fulfilled" ? textResult.value.trim() : "";
      if (!text) {
        toast.error("PDF에서 텍스트를 추출할 수 없습니다.");
        return; // finally가 Set에서 제거
      }

      let newDriveFile: SideDishAssessmentFile | null = null;
      if (driveResult.status === "fulfilled") {
        newDriveFile = { name: file.name, driveUrl: driveResult.value.url, driveId: driveResult.value.id };
        toast.success("Google Drive에 저장됐습니다.");
      } else {
        toast.warning("Drive 저장 실패. AI 분석은 계속 진행합니다.");
      }

      const result = await callAnalyze({ data: { text, clientId: client.id } });
      if (!result.ok) {
        toast.error(result.error || "AI 분석에 실패했습니다.");
        return; // finally가 Set에서 제거
      }

      const updated = buildMergedRecord(result, record, newDriveFile);
      setEditRecord(updated);
      setEditDialogKey((k) => k + 1); // Fix #10: 강제 리마운트
      setEditDialogOpen(true);
    } catch (e) {
      toast.error(aiErrorMsg((e as Error).message));
    } finally {
      // Fix #6: Set에서 이 record.id만 제거
      setReanalyzingIds((ids) => {
        const next = new Set(ids);
        next.delete(record.id);
        return next;
      });
    }
  }

  async function deleteRecord(id: string) {
    if (!confirm("이 실태조사 기록을 삭제하시겠습니까?")) return;
    const cur = splitNote(client.note);
    const next = cur.sideDishAssessments.filter((s) => s.id !== id);
    const newNote = joinNote(cur.note, cur.reassessments, cur.goalAnalysis, cur.closeReason, next, cur.mealOpinion, cur.familyMembers);
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
          밑반찬 실태조사 · PDF 선택 시 Drive 자동 저장 후 AI 분석
          <AiModelBadge className="ml-2" />
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={isBusy}
            onClick={() => {
              const id = crypto.randomUUID();
              setEditRecord(emptyAssessment(id));
              setAddStep("edit");
              setEditDialogKey((k) => k + 1); // Fix #10
              setEditDialogOpen(true);
            }}>
            <Plus className="h-3.5 w-3.5 mr-1" />직접 입력
          </Button>
          <label className="cursor-pointer">
            <Button size="sm" variant="outline" asChild disabled={isBusy}>
              <span><Upload className="h-3.5 w-3.5 mr-1" />PDF 선택</span>
            </Button>
            {/* Fix #4: onChange 후 e.target.value 초기화 → 같은 파일 재선택 가능 */}
            <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" disabled={isBusy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { handleFileSelect(f); e.target.value = ""; } }} />
          </label>
        </div>
      </div>

      {/* 파일 상태 바 */}
      {addStep !== "idle" && addStep !== "edit" && selectedFile && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-sm truncate text-muted-foreground">
            {addStep === "loading" ? loadingMsg || "처리 중…" : selectedFile.name}
          </span>

          {addStep === "loading" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />}

          {addStep === "ready" && (
            <>
              {driveFile?.driveUrl && (
                <a href={driveFile.driveUrl} onClick={(e) => { e.preventDefault(); openDriveFile(driveFile.driveUrl, "원본 PDF", { kind: "밑반찬 원본 PDF" }); }} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline shrink-0 flex items-center gap-0.5" title="Drive에서 열기">
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              {/* AI 분석 버튼 — 재사정 스타일 */}
              <Button size="sm" onClick={handleAnalyze} className="shrink-0 gap-1.5">
                <Sparkles className="h-3.5 w-3.5" />
                AI 분석
              </Button>
              <button type="button" onClick={resetUpload}
                className="text-muted-foreground hover:text-foreground shrink-0" title="취소">
                <X className="h-4 w-4" />
              </button>
            </>
          )}

          {addStep === "analyzing" && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground shrink-0">
              <Loader2 className="h-4 w-4 animate-spin" />분석 중…
            </div>
          )}
        </div>
      )}

      {/* 실태조사 목록 */}
      {sorted.length === 0 ? (
        <div className="rounded-md border border-dashed border-border py-10 flex flex-col items-center gap-2 text-muted-foreground">
          <FileText className="h-8 w-8 opacity-40" />
          <p className="text-sm">실태조사 기록이 없습니다.</p>
          <p className="text-xs">PDF를 업로드하거나 직접 입력하세요.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((r, idx) => (
            <AssessmentCard
              key={r.id}
              record={r}
              initialOpen={idx === 0}
              onDelete={() => deleteRecord(r.id)}
              onEdit={() => {
                setEditRecord(structuredClone(r));
                setEditDialogKey((k) => k + 1);
                setEditDialogOpen(true);
              }}
              onReanalyzeFile={(file) => handleReanalyzeFile(r, file)}
              isReanalyzing={reanalyzingIds.has(r.id)} // Fix #6
            />
          ))}
        </div>
      )}

      {/* 편집 다이얼로그 */}
      {editRecord && (
        <AddDialog
          key={editDialogKey} // Fix #10: key 변경으로 강제 리마운트
          open={editDialogOpen}
          // Fix #2: addStep === "edit" 일 때만 resetUpload() (신규 업로드 흐름)
          // 재분석으로 열릴 경우 addStep이 "idle"|"ready" 등이므로 resetUpload 하지 않음
          onOpenChange={(v) => {
            setEditDialogOpen(v);
            if (!v) {
              setEditRecord(null);
              if (addStep === "edit") resetUpload();
            }
          }}
          initial={editRecord}
          onConfirm={saveRecord}
        />
      )}
    </div>
  );
}
