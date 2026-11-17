/**
 * TranscriptViewer — 상담/전사 원문 보기·수정 컴포넌트
 *
 * 세 가지 저장 모드:
 *   1. 짧은 텍스트 (< 1 000자) → 바로 표시
 *   2. 긴 텍스트 → <details> 열릴 때 Drive에 자동 업로드 후 DB 갱신,
 *      이후 "drive:<id>" 참조를 저장해 Supabase 용량 절감
 *   3. "drive:<id>" 참조 → <details> 열릴 때 Drive에서 읽어 표시
 *
 * 편집 모드:
 *   - "수정" 버튼 클릭 → Textarea로 전환
 *   - "AI 다듬기" → Gemini가 구어체 전사 텍스트를 읽기 좋은 형태로 정리
 *   - "되돌리기" → 다듬기 전 원문 복원
 *   - 저장 → activity_logs.transcript DB 업데이트
 *   - Drive 참조 방식인 경우 Drive 파일도 함께 갱신
 */
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Pencil, Check, X, Sparkles, Undo2 } from "lucide-react";
import { AiModelBadge } from "@/components/AiModelBadge";
import { modelFromResponse } from "@/lib/ai-model";
import { readDriveFile, uploadTextToDrive, isDriveRef, driveIdFromRef } from "@/lib/drive";
import { toast } from "sonner";
import { AI_REFUSED_MESSAGE, assertAiAllowed } from "@/lib/ai-consent";
import { useAiSendNotice } from "@/components/AiSendNotice";

interface TranscriptViewerProps {
  /** activity_logs.id — Drive 이전 후 DB 갱신에 사용 */
  logId: string;
  /** activity_logs.transcript 원본 값 */
  transcript: string | null | undefined;
  /** DB 갱신 완료 시 부모가 로컬 상태를 업데이트하도록 */
  onMigrated?: (newValue: string) => void;
  /** 전사 텍스트 편집 저장 후 부모가 목록을 새로고침하도록 */
  onChanged?: () => void;
  /** 텍스트 길이 기준 (이 이상이면 Drive 이전 대상). 기본 1000자 */
  migrateThreshold?: number;
  /** AI 활용을 거부한 대상자면 true — AI 다듬기를 막는다 */
  aiBlocked?: boolean;
  /** 대상자 ID — AI 다듬기 직전에 DB의 최신 거부 여부를 다시 확인한다 */
  clientId?: string;
}

/**
 * 전사 원문 <details> 블록.
 * 부모 컴포넌트에서 {l.transcript && <TranscriptViewer logId={l.id} transcript={l.transcript} />}
 * 로 대체하면 됩니다.
 */
export function TranscriptViewer({
  logId,
  transcript,
  onMigrated,
  onChanged,
  migrateThreshold = 1000,
  aiBlocked = false,
  clientId,
}: TranscriptViewerProps) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState(false);

  // 편집 모드
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // AI 다듬기
  const [refineBusy, setRefineBusy] = useState(false);
  const [refineModel, setRefineModel] = useState<string | null>(null); // 마지막 다듬기를 실제로 만든 모델
  const [preRefine, setPreRefine] = useState<string | null>(null); // 되돌리기용
  // AI 로 보내기 전 "이름·민감정보가 전송된다"는 안내(하루 한 번만 보기 가능)
  const { confirmAiSend, noticeDialog } = useAiSendNotice();

  if (!transcript) return null;

  /** <details> 처음 열릴 때 한 번만 실행 */
  async function handleToggle(open: boolean) {
    if (!open || opened) return;
    setOpened(true);

    // ── 케이스 1: Drive 참조 ────────────────────────────────────────────
    if (isDriveRef(transcript!)) {
      setLoading(true);
      try {
        const fetched = await readDriveFile(supabase, driveIdFromRef(transcript!));
        setText(fetched);
      } catch {
        setText("Drive에서 원문을 불러오지 못했습니다.");
      }
      setLoading(false);
      return;
    }

    // ── 케이스 2: 짧은 텍스트 ─────────────────────────────────────────
    if (transcript!.length < migrateThreshold) {
      setText(transcript!);
      return;
    }

    // ── 케이스 3: 긴 텍스트 → Drive 이전 ────────────────────────────────
    setText(transcript!); // 먼저 표시하고
    setLoading(true);
    try {
      const { id: driveId } = await uploadTextToDrive(supabase, {
        name: `transcript_${logId}.txt`,
        text: transcript!,
        folderName: "전사기록",
      });
      const ref = `drive:${driveId}`;
      const { error } = await supabase
        .from("activity_logs")
        .update({ transcript: ref })
        .eq("id", logId);
      if (!error) {
        onMigrated?.(ref);
      }
    } catch {
      toast.error("전사 원문 Drive 이전에 실패했어요. 원문은 그대로 표시됩니다.", {
        id: `tx-migrate-${logId}`,
        duration: 3000,
      });
    }
    setLoading(false);
  }

  /** 수정 버튼 클릭 — 현재 표시된 텍스트로 편집창 열기 */
  function startEdit() {
    const current = displayText ?? "";
    setEditText(current);
    setPreRefine(null); // 수정 새로 시작 시 되돌리기 초기화
    setEditing(true);
  }

  /** 편집 취소 */
  function cancelEdit() {
    setEditing(false);
    setEditText("");
    setPreRefine(null);
  }

  /** AI 다듬기 — Gemini로 구어체 전사 텍스트 정리 */
  async function refineTranscript() {
    const draft = editText.trim();
    if (draft.length < 5) return toast.error("다듬을 내용을 입력해 주세요.");
    if (aiBlocked) return toast.error(AI_REFUSED_MESSAGE);
    if (!(await confirmAiSend())) return;
    setRefineBusy(true);
    try {
      await assertAiAllowed(supabase, clientId);
      const { data, error } = await supabase.functions.invoke("gemini", {
        body: {
          system:
            "당신은 한국 사회복지관 사례관리 상담 전사 텍스트 정리 전문가입니다.\n" +
            "아래 텍스트는 음성 녹음을 AI가 자동 전사한 결과입니다.\n\n" +
            "다음 규칙에 따라 읽기 좋게 정리해 주세요:\n" +
            "1) 구어체 표현·필러 단어(어, 음, 그냥, 뭐, 인데요 등)를 자연스럽게 다듬으세요.\n" +
            "2) 반복·중복 표현은 한 번만 남기세요.\n" +
            "3) '담당자:' / '어르신:' 등 발화자 구분이 있으면 그대로 유지하세요.\n" +
            "4) [불명확] 표시는 그대로 두세요.\n" +
            "5) 내용(사실·발화 의미)을 임의로 변경하거나 추가하지 마세요.\n" +
            "6) 정리된 텍스트만 출력하세요. 설명·머리말 없이.",
          user: `[전사 텍스트]\n${draft}\n\n위 내용을 규칙에 따라 정리해 주세요.`,
          temperature: 0.2,
        },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      const refined = (data?.text ?? "").trim();
      if (refined) {
        setRefineModel(modelFromResponse(data));
        setPreRefine(editText); // 되돌리기를 위해 현재 텍스트 보존
        setEditText(refined);
        toast.success("AI가 전사 텍스트를 정리했어요. 확인 후 저장하세요.");
      }
    } catch (e) {
      const msg = (e as Error).message || "";
      if (/GEMINI_API_KEY missing/.test(msg)) {
        toast.message("제미나이 키가 설정되면 AI 다듬기를 사용할 수 있어요.");
      } else {
        toast.error("다듬기 실패: " + msg);
      }
    }
    setRefineBusy(false);
  }

  /** 편집 저장 — DB 업데이트 (Drive 참조 방식이면 Drive도 갱신) */
  async function saveEdit() {
    if (!editText.trim()) return;
    setSavingEdit(true);
    try {
      let valueToSave = editText.trim();

      // Drive 참조 방식인 경우 Drive 파일도 업데이트
      if (isDriveRef(transcript!)) {
        const { id: driveId } = await uploadTextToDrive(supabase, {
          name: `transcript_${logId}.txt`,
          text: valueToSave,
          folderName: "전사기록",
        });
        valueToSave = `drive:${driveId}`;
      }

      const { error } = await supabase
        .from("activity_logs")
        .update({ transcript: valueToSave })
        .eq("id", logId);

      if (error) throw new Error(error.message);

      // 화면 반영
      setText(editText.trim());
      onMigrated?.(valueToSave);
      setEditing(false);
      setEditText("");
      setPreRefine(null);
      toast.success("전사 원문이 수정되었습니다.");
      onChanged?.(); // 부모 목록 새로고침 (탭 전환 후에도 최신 상태 유지)
    } catch (e) {
      toast.error("저장 실패: " + (e as Error).message);
    }
    setSavingEdit(false);
  }

  const displayText = text ?? (isDriveRef(transcript) ? null : transcript);

  return (
    <details
      className="mt-1.5 text-xs text-muted-foreground"
      onToggle={(e) => handleToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none">
        전사 원문 보기
        {!isDriveRef(transcript) && transcript.length >= migrateThreshold && (
          <span className="ml-1 text-[10px] text-amber-500">(Drive 이전 예정)</span>
        )}
      </summary>
      {noticeDialog}

      {loading && (
        <span className="mt-1 flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" /> 불러오는 중...
        </span>
      )}

      {/* 편집 모드 */}
      {editing ? (
        <div className="mt-2 space-y-1.5">
          <textarea
            className="w-full rounded border border-border bg-background p-2 text-xs leading-relaxed text-foreground outline-none focus:ring-1 focus:ring-primary"
            rows={6}
            value={editText}
            onChange={(e) => {
              setEditText(e.target.value);
              // 직접 수정 시 되돌리기 기준점 초기화 (AI 다듬기 후 → 수기 수정이면 되돌릴 기준 없앰)
              if (preRefine !== null) setPreRefine(null);
            }}
            disabled={savingEdit || refineBusy}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {/* AI 다듬기 */}
            <button
              onClick={refineTranscript}
              disabled={refineBusy || savingEdit || editText.trim().length < 5}
              className="flex items-center gap-1 rounded bg-violet-600 px-2 py-0.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {refineBusy
                ? <><Loader2 className="h-3 w-3 animate-spin" /> 정리 중</>
                : <><Sparkles className="h-3 w-3" /> AI 다듬기</>
              }
            </button>
            <AiModelBadge model={refineModel} />
            {/* 되돌리기 — AI 다듬기 직후에만 표시 */}
            {preRefine !== null && (
              <button
                onClick={() => { setEditText(preRefine); setPreRefine(null); }}
                disabled={savingEdit || refineBusy}
                className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                <Undo2 className="h-3 w-3" /> 되돌리기
              </button>
            )}
            {/* 저장 */}
            <button
              onClick={saveEdit}
              disabled={savingEdit || refineBusy || !editText.trim()}
              className="flex items-center gap-1 rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {savingEdit
                ? <><Loader2 className="h-3 w-3 animate-spin" /> 저장 중</>
                : <><Check className="h-3 w-3" /> 저장</>
              }
            </button>
            {/* 취소 */}
            <button
              onClick={cancelEdit}
              disabled={savingEdit || refineBusy}
              className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <X className="h-3 w-3" /> 취소
            </button>
          </div>
        </div>
      ) : (
        displayText && (
          <div className="group mt-1 flex items-start gap-1.5">
            <p className="flex-1 whitespace-pre-wrap">{displayText}</p>
            <button
              onClick={startEdit}
              title="전사 원문 수정"
              className="mt-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
            >
              <Pencil className="h-3 w-3 text-muted-foreground" />
            </button>
          </div>
        )
      )}
    </details>
  );
}
