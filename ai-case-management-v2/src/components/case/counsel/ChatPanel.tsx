import { openDriveFile } from "@/lib/drive-viewer";
import { logView } from "@/lib/view-log";
import { ClientName } from "@/components/NameMask";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AiModelBadge } from "@/components/AiModelBadge";
import { modelFromResponse } from "@/lib/ai-model";
import { aiLabel, ensureHeaderName, restoreNames } from "@/lib/ai-names";
import { printCounselRecord, DEFAULT_APPROVAL_ROLES, type ApprovalRole } from "@/lib/print-counsel";
import { TranscriptViewer } from "../TranscriptViewer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { uploadToDrive } from "@/lib/drive";
import { AI_REFUSED_MESSAGE, assertAiAllowed, isAiBlocked } from "@/lib/ai-consent";
import { prepareAiContext } from "@/lib/ai-context";
import { useAiSendNotice } from "@/components/AiSendNotice";
import {
  Loader2,
  Send,
  Search,
  Sparkles,
  Undo2,
  Copy,
  ChevronDown,
  Printer,
  X,
  Pencil,
  Trash2,
  Check,
  CornerDownLeft,
  Mic,
  MicOff,
  Play,
  FileAudio,
} from "lucide-react";
import {
  CONTACT_METHODS,
  programsOf,
  programStyle,
  hasCareLevel,
  careLevelOf,
  careLevelStyle,
  riskStyle,
  getActiveCarePlanActions,
  type Client,
  type ActivityLog,
  type ActiveAction,
  type Provision,
} from "@/lib/case-types";
import { insertCarePlanActionLinks, syncCarePlanActionLinks, yearMapOf, applyLinksToActions, type CarePlanLinkRow } from "@/lib/care-plan-links";
import { MethodIcon, Highlighted } from "./counsel-utils";
import { entryIso, formatLogDateTime, isTimeHidden, toKstDate } from "@/lib/log-time";
import {
  ProvisionQuickAdd,
  buildProvisionRows,
  findDuplicateProvisions,
  newProvisionDraft,
  type ProvisionDraft,
} from "./ProvisionQuickAdd";

export function ChatPanel({
  client,
  thread,
  logs,
  workerName,
  initialKeyword,
  onChanged,
  canWrite = true,
  planLinks = [],
  provisions = [],
}: {
  client: Client;
  thread: ActivityLog[];
  logs: ActivityLog[];
  workerName: string;
  initialKeyword?: string;
  onChanged: () => void;
  canWrite?: boolean;
  planLinks?: CarePlanLinkRow[];
  /** 이 대상자의 제공이력(같은 날 같은 항목 중복 등록 확인용) */
  provisions?: Provision[];
}) {
  const [method, setMethod] = useState("전화");
  const [counselTitle, setCounselTitle] = useState("");
  const [note, setNote] = useState("");
  const [counselResult, setCounselResult] = useState("");
  const [direction, setDirection] = useState("");
  const [hasRefined, setHasRefined] = useState(false);
  const [busy, setBusy] = useState(false);
  const sendingRef = useRef(false);
  // AI 로 보내기 전 "이름·민감정보가 전송된다"는 안내(하루 한 번만 보기 가능)
  const { confirmAiSend, noticeDialog } = useAiSendNotice();
  const [refineBusy, setRefineBusy] = useState(false);
  // 마지막 AI 다듬기·전사 결과를 실제로 만든 모델(응답에 들어 있는 값). 아직 없으면 설정된 모델을 표시한다.
  const [refineModel, setRefineModel] = useState<string | null>(null);
  const [transcribeModel, setTranscribeModel] = useState<string | null>(null);
  const [preRefine, setPreRefine] = useState<string | null>(null);
  const [preRefineTitle, setPreRefineTitle] = useState<string | null>(null);
  const [preRefineResult, setPreRefineResult] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editText, setEditText] = useState("");
  const [editResult, setEditResult] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editTime, setEditTime] = useState("12:00");
  // 시간 없이 저장된 기록(정오 정각)을 수정할 때는 시간 입력을 보이지 않고 그대로 정오로 둔다
  const [editHasTime, setEditHasTime] = useState(true);
  const [editMethod, setEditMethod] = useState("전화");
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [editRefineBusy, setEditRefineBusy] = useState(false);
  const [editPreRefine, setEditPreRefine] = useState<string | null>(null);
  const [editDirection, setEditDirection] = useState("");
  const [editHasRefined, setEditHasRefined] = useState(false);
  const [fromDate, setFromDate] = useState("");

  // Fallback: 부모 state에 기록이 없으면 직접 조회
  const [directThread, setDirectThread] = useState<ActivityLog[] | null>(null);
  useEffect(() => {
    if (thread.length > 0) {
      setDirectThread(null);
      return;
    }
    let cancelled = false;
    supabase
      .from("activity_logs")
      .select("*")
      .eq("client_id", client.id)
      .eq("org_id", client.org_id) // SECURITY: org_id 필터로 타기관 데이터 접근 차단
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (!cancelled && data)
          setDirectThread(data as ActivityLog[]);
      });
    return () => { cancelled = true; };
  }, [client.id, client.org_id, thread.length]);

  // directThread가 있으면 우선 사용, 없으면 부모에서 받은 thread 사용
  const effectiveThread = directThread ?? thread;
  // 계획 항목 연동 (새 상담)
  const [planLinkOpen, setPlanLinkOpen] = useState(false);
  const [selectedPlanIds, setSelectedPlanIds] = useState<Set<string>>(new Set());
  // 제공이력 함께 등록 (새 상담)
  const [provOpen, setProvOpen] = useState(false);
  const [provDrafts, setProvDrafts] = useState<ProvisionDraft[]>(() => [newProvisionDraft()]);
  const activePlanActions: ActiveAction[] = useMemo(() => {
    const base = getActiveCarePlanActions(client);
    const clientLinks = planLinks.filter((l) => l.client_id === client.id);
    return applyLinksToActions(base, clientLinks);
  }, [client, planLinks]);
  // logId → 연동된 계획 항목 맵 (렌더링 중 filter 반복 방지)
  const linkedByLogId = useMemo(() => {
    const map = new Map<string, ActiveAction[]>();
    for (const aa of activePlanActions) {
      for (const logId of (aa.action.linkedLogIds ?? [])) {
        const arr = map.get(logId) ?? [];
        arr.push(aa);
        map.set(logId, arr);
      }
    }
    return map;
  }, [activePlanActions]);
  // 계획 항목 연동 (기존 상담 수정)
  const [editPlanOpen, setEditPlanOpen] = useState(false);
  const [editPlanSelectedIds, setEditPlanSelectedIds] = useState<Set<string>>(new Set());
  // 새 상담 작성용 날짜 (기본값: 오늘). 시각은 입력 시점의 실제 시각으로 저장하되 화면에는 숨긴다(log-time.ts)
  const [counselDate, setCounselDate] = useState(() =>
    new Date().toLocaleDateString("en-CA"), // YYYY-MM-DD (로컬 기준)
  );
  const [toDate, setToDate] = useState("");

  // ── 음성녹음 ──────────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSec, setRecordingSec] = useState(0);
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  const [driveAudioUrl, setDriveAudioUrl] = useState<string | null>(null);
  const [rawTranscript, setRawTranscript] = useState("");
  const [transcribeBusy, setTranscribeBusy] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // audioBlobUrl을 ref로도 추적 → cleanup에서 최신값 참조 가능
  const audioBlobUrlRef = useRef<string | null>(null);

  // 컴포넌트 언마운트 시 타이머·Object URL·마이크 스트림 정리 (메모리 누수 방지)
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (audioBlobUrlRef.current) URL.revokeObjectURL(audioBlobUrlRef.current);
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  function resetRecording() {
    if (audioBlobUrlRef.current) URL.revokeObjectURL(audioBlobUrlRef.current);
    audioBlobUrlRef.current = null;
    setAudioBlobUrl(null);
    setDriveAudioUrl(null);
    setRawTranscript("");
    setRecordingSec(0);
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "audio/webm";
      const mr = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(blob);
        audioBlobUrlRef.current = url;
        setAudioBlobUrl(url);
        autoTranscribe(blob, mimeType);
      };
      mr.start(1000);
      mediaRecorderRef.current = mr;
      setIsRecording(true);
      setRecordingSec(0);
      timerRef.current = setInterval(() => setRecordingSec((s) => s + 1), 1000);
    } catch {
      toast.error("마이크 권한이 필요합니다. 브라우저 설정에서 마이크 접근을 허용해 주세요.");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    setIsRecording(false);
  }

  async function autoTranscribe(blob: Blob, mimeType: string) {
    setTranscribeBusy(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(",")[1]); // data:...;base64, 제거
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const now = new Date();
      const fileName = `상담녹음_${client.client_code ?? client.id.slice(0, 8)}_${now.toLocaleDateString("en-CA")}_${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}.webm`;
      if (isAiBlocked(client)) {
        // AI 활용에 동의하지 않은(미설정·거부) 대상자: 구글 AI로 보내지 않고 녹음 파일만 드라이브에 저장
        const { url } = await uploadToDrive(supabase, { name: fileName, mimeType, data: base64, folderName: "상담녹음" });
        setDriveAudioUrl(url);
        toast.info("AI 활용에 동의하지 않은 대상자라 전사하지 않고 녹음 파일만 저장했습니다.");
        setTranscribeBusy(false);
        return;
      }
      const { data, error } = await supabase.functions.invoke("transcribe-audio", {
        body: { name: fileName, mimeType, data: base64, clientId: client.id },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      if (data?.audioUrl) setDriveAudioUrl(data.audioUrl);
      // Drive 실패해도 전사 결과는 표시 (driveError는 별도 경고)
      if (data?.driveError) {
        toast.warning("Drive 업로드 실패 — 전사 결과는 확인 가능합니다. (녹음 파일 저장 안 됨)");
        console.warn("[transcribe-audio] Drive error:", data.driveError);
      }
      // 화면을 연 뒤 다른 담당자가 거부로 바꿔 서버가 전사를 건너뛴 경우
      if (data?.aiBlocked) {
        toast.info("AI 활용에 동의하지 않은 대상자라 전사하지 않고 녹음 파일만 저장했습니다.");
        setTranscribeBusy(false);
        return;
      }
      if (data?.transcript) {
        setTranscribeModel(modelFromResponse(data));
        setRawTranscript(data.transcript);
        toast.success("전사 완료! 내용을 확인하고 필요하면 수정하세요.");
      } else {
        toast.warning("전사 결과가 비어 있습니다. 녹음 상태를 확인해 주세요.");
      }
    } catch (e) {
      toast.error("전사 실패: " + (e as Error).message);
    }
    setTranscribeBusy(false);
  }

  function applyTranscript() {
    if (!rawTranscript.trim()) return;
    setNote((prev) => prev ? prev + "\n\n" + rawTranscript : rawTranscript);
    toast.success("전사 내용이 상담내용에 적용되었습니다. AI 다듬기를 실행해 보세요.");
  }

  const fmtSec = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  // ─────────────────────────────────────────────────────

  const [kw, setKw] = useState(initialKeyword ?? "");
  const [kwOpen, setKwOpen] = useState(!!initialKeyword?.trim());

  // 전체 검색에서 넘어온 키워드를 대상자별 검색에도 반영 (있으면 검색창 자동 표시)
  useEffect(() => {
    setKw(initialKeyword ?? "");
    if (initialKeyword?.trim()) setKwOpen(true);
  }, [initialKeyword]);

  // 기간 필터 (시작일~종료일, 달력으로 선택). 비어 있으면 전체.
  const visibleThread = useMemo(() => {
    const fromT = fromDate ? new Date(fromDate + "T00:00:00").getTime() : null;
    const toT = toDate ? new Date(toDate + "T23:59:59").getTime() : null;
    if (fromT === null && toT === null) return effectiveThread;
    return effectiveThread.filter((l) => {
      const t = new Date(l.created_at).getTime();
      if (fromT !== null && t < fromT) return false;
      if (toT !== null && t > toT) return false;
      return true;
    });
  }, [effectiveThread, fromDate, toDate]);

  // 대상자별 키워드 검색: 기간 필터 결과에서 키워드 포함 기록만
  const kwLower = kw.trim().toLowerCase();
  const shownThread = useMemo(() => {
    if (!kwLower) return visibleThread;
    return visibleThread.filter((l) =>
      ((l.note ?? "") + " " + (l.transcript ?? "")).toLowerCase().includes(kwLower),
    );
  }, [visibleThread, kwLower]);
  const kwStat = useMemo(() => {
    if (!kwLower) return null;
    const last = shownThread.reduce((m, l) => Math.max(m, new Date(l.created_at).getTime()), 0);
    return { count: shownThread.length, last: last ? new Date(last) : null };
  }, [shownThread, kwLower]);
  const items = useMemo(() => {
    let last = "";
    return shownThread.map((l) => {
      const dateStr = new Date(l.created_at).toLocaleDateString("ko-KR", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "short",
      });
      const showDate = dateStr !== last;
      last = dateStr;
      return { l, dateStr, showDate };
    });
  }, [shownThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [effectiveThread.length, client.id]);

  function startEdit(l: ActivityLog) {
    setEditingId(l.id);
    setEditTitle(l.title ?? "");
    setEditText(l.note ?? "");
    setEditResult(l.result ?? "");
    setEditMethod(l.method ?? "전화");
    setEditDate(new Date(l.created_at).toLocaleDateString("en-CA"));
    // KST 시각 추출 (UTC+9 보정)
    const kst = new Date(new Date(l.created_at).getTime() + 9 * 60 * 60 * 1000);
    setEditTime(`${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}`);
    setEditHasTime(!isTimeHidden(l));
    // 이미 연동된 계획 항목을 미리 체크 상태로 복원
    const preSelected = new Set(
      activePlanActions
        .filter((aa) => (aa.action.linkedLogIds ?? []).includes(l.id))
        .map((aa) => aa.action.id),
    );
    setEditPlanSelectedIds(preSelected);
    // 기존 연동 항목이 있으면 체크박스도 자동으로 열기
    setEditPlanOpen(preSelected.size > 0);
    setEditPreRefine(null);
    setEditDirection("");
    setEditHasRefined(false);
  }
  async function saveEdit(id: string) {
    const text = editText.trim();
    if (!text) return toast.error("내용을 입력해주세요.");
    // 선택한 날짜 + 시간을 KST(+09:00) 기준으로 저장. 시간을 비우면 저장 전에 안내(처리 중 상태로 멈추지 않게)
    const editAt = editDate ? new Date(`${editDate}T${editTime}:00+09:00`) : null;
    if (editAt && Number.isNaN(editAt.getTime())) return toast.error("상담 날짜와 시간을 확인해 주세요.");
    setRowBusy(id);
    const patch: { title: string | null; note: string; result: string | null; method: string; created_at?: string } = {
      title: editTitle.trim() || null,
      note: text,
      result: editResult.trim() || null,
      method: editMethod,
    };
    if (editAt) patch.created_at = editAt.toISOString();
    const { error } = await supabase.from("activity_logs").update(patch).eq("id", id);
    setRowBusy(null);
    if (error) return toast.error(error.message);
    // 계획 항목 연동 — care_plan_action_links 표에만 저장한다. editPlanOpen이 false(해제)면 빈 Set으로 기존 연결을 모두 제거(추가 + 해제 모두 반영)
    const effectiveLogIds = editPlanOpen ? editPlanSelectedIds : new Set<string>();
    const linksOk = await syncCarePlanActionLinks(supabase, { clientId: client.id, orgId: client.org_id, linkedId: id, kind: "log", actionIds: effectiveLogIds, yearByActionId: yearMapOf(activePlanActions) });
    setEditingId(null);
    setEditPlanOpen(false);
    setEditPlanSelectedIds(new Set());
    if (linksOk) toast.success("상담기록이 수정되었습니다.");
    else toast.error("상담기록은 수정됐지만 계획 항목 연동은 저장하지 못했어요. 다시 수정해서 연동을 확인해 주세요.");
    onChanged();
  }
  async function refineEditNote() {
    const draft = editText.trim();
    if (draft.length < 5) return toast.error("다듬을 내용을 조금 더 입력해 주세요.");
    if (isAiBlocked(client)) return toast.error(AI_REFUSED_MESSAGE);
    if (!(await confirmAiSend())) return;
    setEditRefineBusy(true);
    try {
      // 화면을 연 뒤 다른 담당자가 거부로 바꿨을 수 있으므로 전송 직전에 다시 확인
      await assertAiAllowed(supabase, client.id);
      // 이전 상담 현황·문체 예시: 수정 중인 항목은 빼고, 대상자 이름은 지우고, 이름이 남은 다른 대상자 기록은 예시로 쓰지 않는다(ai-context.ts 참고)
      const ctx = await prepareAiContext(supabase, { client, thread, excludeId: editingId });
      const historyText =
        ctx.history.length > 0
          ? `[이전 상담 현황 — 맥락 참고용]\n${ctx.history.map((h, i) => `${i + 1}. [${h.date}]\n${h.text}`).join("\n\n")}\n\n`
          : "";
      const samples = ctx.samples.map((s, i) => `예시 ${i + 1})\n${s}`).join("\n\n");
      if (!samples) toast.message("문체 예시로 쓸 기록이 없어 예시 없이 다듬었어요.");

      const directionHint = editDirection.trim()
        ? `\n\n[담당자 작성 방향]\n${editDirection.trim().slice(0, 300)}`
        : "";
      const { data, error } = await supabase.functions.invoke("gemini", {
        body: {
          system:
            "당신은 한국 사회복지관 사례관리 담당자의 상담일지 작성을 돕는 어시스턴트입니다. " +
            "담당자가 입력한 간단한 초안을, 아래 [기존 상담기록 예시]의 문체·서식을 참고하여 풍성하고 전문적인 상담기록으로 다듬어 주세요.\n\n" +
            `[출력 형식 — 반드시 이 구조 전체를 작성할 것]\n` +
            `■ ${new Date().getFullYear()}년 ${aiLabel(client)} 당사자의 욕구/드러난 문제(재사정기반) : [대상자의 현재 상황·욕구를 한 줄로 요약]\n\n` +
            "· [담당자 행동 및 대화 내용 — 구체적인 발화·상황 포함하여 개조식으로 서술]\n" +
            "· ...\n\n" +
            "결과내용 (진단 및 대처)\n" +
            "■ 당사자의 역할 :\n" +
            "· [대상자가 해야 할 역할 또는 동의한 사항]\n\n" +
            "■ 담당자의 역할 :\n" +
            "· [담당자가 연계·지원할 내용]\n\n" +
            "규칙:\n" +
            "1) 초안에 없는 사실·수치·고유명사·날짜를 절대 지어내지 마세요. 단, 위 출력 형식의 대상자 번호(예: JN0018)는 바꾸지 말고 그대로 쓰세요.\n" +
            "2) 과장 없이 객관적·전문적으로 서술하되, 대화의 흐름이 자연스럽게 드러나도록 구체적으로 작성하세요.\n" +
            "3) [담당자 작성 방향]이 있으면 그 의도를 최우선으로 반영하세요.\n" +
            "4) [이전 상담 현황]이 있으면 대상자의 연속된 맥락을 이해하고 자연스럽게 반영하세요.\n" +
            "5) 결과는 다듬어진 상담기록 본문만 출력하세요. (설명·머리말·따옴표 없이)",
          user:
            historyText +
            (samples ? `[기존 상담기록 예시 — 문체 참고용]\n${samples}\n\n` : "") +
            `[초안]\n${draft}${directionHint}\n\n위 내용을 참고해 초안을 정돈된 상담기록으로 다듬어 주세요.`,
        },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      const refined = ensureHeaderName(restoreNames((data?.text ?? "").trim(), [client]), client);
      if (refined) {
        setRefineModel(modelFromResponse(data));
        setEditPreRefine(editText);
        setEditText(refined);
        setEditHasRefined(true);
        toast.success("AI가 상담기록을 다듬었어요. [되돌리기]로 원문 복원 가능.");
      }
    } catch (e) {
      const msg = (e as Error).message || "";
      if (/GEMINI_API_KEY missing/.test(msg)) {
        toast.message("제미나이 키가 설정되면 AI 다듬기를 사용할 수 있어요.");
      } else {
        toast.error("다듬기 실패: " + msg);
      }
    }
    setEditRefineBusy(false);
  }

  async function deleteLog(id: string) {
    if (!confirm("이 상담기록을 삭제하시겠어요?")) return;
    setRowBusy(id);
    const { error } = await supabase.from("activity_logs").delete().eq("id", id);
    setRowBusy(null);
    if (error) return toast.error(error.message);
    if (editingId === id) setEditingId(null);
    toast.success("삭제되었습니다.");
    onChanged();
  }
  async function copyField(l: ActivityLog, field: "title" | "note" | "result") {
    const labels = { title: "제목", note: "상담내용", result: "결과내용" };
    const values = { title: l.title ?? "", note: l.note ?? "", result: l.result ?? "" };
    const text = values[field];
    if (!text.trim()) return toast.error(`${labels[field]}이 없습니다.`);
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${labels[field]}이 복사되었습니다.`);
    } catch {
      toast.error("복사에 실패했습니다.");
    }
  }

  async function printLog(l: ActivityLog) {
    const { data: { user } } = await supabase.auth.getUser();
    let approvalLine: ApprovalRole[] = DEFAULT_APPROVAL_ROLES;
    if (user) {
      const { data: prof } = await supabase.from("profiles").select("approval_line").eq("id", user.id).single();
      const raw = (prof as { approval_line?: unknown } | null)?.approval_line;
      if (Array.isArray(raw) && raw.length > 0) {
        approvalLine = DEFAULT_APPROVAL_ROLES.map((def) => {
          const found = (raw as Record<string, unknown>[]).find(r => r.role === def.role);
          if (!found) return def;
          return { role: def.role, active: found.active !== undefined ? Boolean(found.active) : true };
        });
      }
    }
    logView({ action: "상담기록서 인쇄", client });
    printCounselRecord(l, client, approvalLine);
  }

  // AI 다듬기: edge function 직접 호출 (Vercel 서버 hop 제거 → 레이턴시 단축)
  async function refineNote() {
    const draft = note.trim();
    if (draft.length < 5) return toast.error("다듬을 내용을 조금 더 입력해 주세요.");
    if (isAiBlocked(client)) return toast.error(AI_REFUSED_MESSAGE);
    if (!(await confirmAiSend())) return;
    setRefineBusy(true);
    try {
      // 화면을 연 뒤 다른 담당자가 거부로 바꿨을 수 있으므로 전송 직전에 다시 확인
      await assertAiAllowed(supabase, client.id);
      // 이전 상담 현황·문체 예시: 대상자 이름은 지우고, 이름이 남은 다른 대상자 기록은 예시로 쓰지 않는다(ai-context.ts 참고)
      const ctx = await prepareAiContext(supabase, { client, thread });
      const historyText =
        ctx.history.length > 0
          ? `[이전 상담 현황 — 맥락 참고용]\n${ctx.history.map((h, i) => `${i + 1}. [${h.date}]\n${h.text}`).join("\n\n")}\n\n`
          : "";
      const samples = ctx.samples.map((s, i) => `예시 ${i + 1})\n${s}`).join("\n\n");
      if (!samples) toast.message("문체 예시로 쓸 기록이 없어 예시 없이 다듬었어요.");
      const directionHint = direction.trim()
        ? `\n\n[담당자 작성 방향]\n${direction.trim().slice(0, 300)}`
        : "";
      const { data, error } = await supabase.functions.invoke("gemini", {
        body: {
          json: true,
          system:
            "당신은 한국 사회복지관 사례관리 담당자의 상담일지 작성을 돕는 어시스턴트입니다. " +
            "담당자가 입력한 간단한 초안을, 아래 [기존 상담기록 예시]의 문체·서식을 참고하여 풍성하고 전문적인 상담기록으로 다듬어 주세요.\n\n" +
            "반드시 아래 JSON 형식으로만 응답하세요:\n" +
            '{ "title": "상담 제목 — 예시 형식: 당사자 욕구기반상담 진행 (신체적 : 파스 지원 욕구 확인) / 형식: [상담유형] ([영역] : [핵심내용])", ' +
            '"note": "상담내용 본문 (개조식, 담당자 행동·대화 중심)", ' +
            '"result": "결과내용(진단 및 대처) — 당사자 역할과 담당자 역할로 구분" }\n\n' +
            "note 형식:\n" +
            `■ ${new Date().getFullYear()}년 ${aiLabel(client)} 당사자의 욕구/드러난 문제(재사정기반) : [한 줄 요약]\n\n` +
            "· [담당자 행동 및 대화 — 구체적으로 개조식]\n" +
            "· ...\n\n" +
            "result 형식:\n" +
            "■ 당사자의 역할 :\n· [대상자 역할/동의 사항]\n\n" +
            "■ 담당자의 역할 :\n· [담당자 연계·지원 내용]\n\n" +
            "규칙:\n" +
            "1) 초안에 없는 사실·수치·고유명사·날짜를 절대 지어내지 마세요. 단, note 형식의 대상자 번호(예: JN0018)는 바꾸지 말고 그대로 쓰세요.\n" +
            "2) 과장 없이 객관적·전문적으로 서술하세요.\n" +
            "3) [담당자 작성 방향]이 있으면 그 의도를 최우선으로 반영하세요.\n" +
            "4) [이전 상담 현황]이 있으면 대상자의 연속된 맥락을 반영하세요.",
          user:
            historyText +
            (samples ? `[기존 상담기록 예시 — 문체 참고용]\n${samples}\n\n` : "") +
            `[초안]\n${draft}${directionHint}\n\n위 내용을 참고해 JSON으로 다듬어 주세요.`,
        },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      const raw = (data?.text ?? "").trim();
      if (raw) {
        let parsedTitle = "";
        let parsedNote = ensureHeaderName(restoreNames(raw, [client]), client);
        let parsedResult = "";
        try {
          const p = JSON.parse(raw) as { title?: string; note?: string; result?: string };
          parsedTitle = restoreNames((p.title ?? "").trim(), [client]);
          parsedNote = ensureHeaderName(restoreNames((p.note ?? raw).trim(), [client]), client);
          parsedResult = restoreNames((p.result ?? "").trim(), [client]);
        } catch {
          // JSON 이 아닌 일반 글이면 전체를 note 로 쓰되, JSON 처럼 보이는데 파싱이 안 되면(응답이 중간에 잘림) 본문을 덮어쓰지 않는다
          if (raw.trimStart().startsWith("{")) throw new Error("AI 응답이 중간에 끊겨 적용하지 않았어요. 본문이 매우 길면 나눠서 다시 시도해 주세요.");
        }
        setPreRefine(note);
        setPreRefineTitle(counselTitle);
        setPreRefineResult(counselResult);
        setNote(parsedNote);
        if (parsedTitle) setCounselTitle(parsedTitle);
        if (parsedResult) setCounselResult(parsedResult);
        setRefineModel(modelFromResponse(data));
        setHasRefined(true);
        toast.success("AI가 상담기록을 다듬었어요. [되돌리기]로 원문 복원 가능.");
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

  function undoRefine() {
    if (preRefine === null) return;
    setNote(preRefine);
    if (preRefineTitle !== null) setCounselTitle(preRefineTitle);
    if (preRefineResult !== null) setCounselResult(preRefineResult);
    setPreRefine(null);
    setPreRefineTitle(null);
    setPreRefineResult(null);
  }

  async function send() {
    if (sendingRef.current) return; // 저장 중 Ctrl+Enter 반복 등으로 같은 상담이 여러 번 저장되는 것을 막는다
    sendingRef.current = true;
    try {
      await sendCore();
    } catch (e) {
      toast.error("저장 중 오류가 났어요: " + ((e as Error).message || ""));
    } finally {
      // 예외가 나도 저장 잠금이 풀리도록 한다(안 그러면 새로고침 전까지 저장이 안 됨)
      sendingRef.current = false;
      setBusy(false);
    }
  }

  async function sendCore() {
    if (!note.trim()) return;
    // 날짜는 고른 날짜, 시각은 입력한 실제 시각으로 저장한다(화면에는 날짜만 표시). 날짜를 비우면 저장 전에 안내
    if (!counselDate || Number.isNaN(new Date(`${counselDate}T12:00:00+09:00`).getTime())) return toast.error("상담 날짜를 확인해 주세요.");
    const logDate = entryIso(counselDate);
    // 제공이력 함께 등록: 상담을 저장하기 전에 입력 내용과 중복 여부를 먼저 확인한다
    let provRows: ReturnType<typeof buildProvisionRows>["rows"] = [];
    if (provOpen) {
      const built = buildProvisionRows(provDrafts, { clientId: client.id, orgId: client.org_id, counselDate });
      if (built.error) return toast.error(built.error);
      provRows = built.rows;
      const dups = findDuplicateProvisions(provRows, provisions);
      if (
        dups.length > 0 &&
        !confirm(
          `같은 날 이미 등록된 제공이력이 있어요: ${dups.map((d) => `${d.title}(${d.provided_at})`).join(", ")}\n그래도 함께 등록할까요?`,
        )
      ) {
        return;
      }
    }
    sendingRef.current = true;
    setBusy(true);
    const logRow = {
      client_id: client.id,
      org_id: client.org_id,
      method,
      title: counselTitle.trim() || null,
      note: note.trim(),
      result: counselResult.trim() || null,
      worker_name: workerName,
      created_at: logDate,
      audio_url: driveAudioUrl ?? null,
      // 담당자가 수정한 전사 텍스트 저장 (나중에 TranscriptViewer에서 추가수정 가능)
      transcript: rawTranscript.trim() || null,
    };
    // hide_time: 화면에는 날짜만 표시(시각은 같은 날 순서용으로만 저장)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ins = await supabase.from("activity_logs").insert({ ...logRow, hide_time: true } as any).select("id").single();
    if (ins.error && /hide_time/.test(ins.error.message)) {
      // hide_time 컬럼이 아직 없는 DB: 상담 저장이 막히지 않게 컬럼 없이 다시 저장한다
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ins = await supabase.from("activity_logs").insert(logRow as any).select("id").single();
    }
    const { data: inserted, error } = ins;
    if (error) {
      sendingRef.current = false;
      setBusy(false);
      return toast.error(error.message);
    }
    await supabase
      .from("clients")
      .update({ last_contact_at: logDate, last_contact_method: method })
      .eq("id", client.id);
    // 계획 항목 연동 — care_plan_action_links 표에만 저장한다
    if (selectedPlanIds.size > 0 && inserted) {
      const newLogId = (inserted as { id: string }).id;
      const linksOk = await insertCarePlanActionLinks(supabase, { clientId: client.id, orgId: client.org_id, linkedId: newLogId, kind: "log", actionIds: selectedPlanIds, yearByActionId: yearMapOf(activePlanActions) });
      if (!linksOk) toast.error("상담은 저장됐지만 계획 항목 연동은 저장하지 못했어요. 상담기록 수정에서 연동을 다시 선택해 주세요.");
    }
    // 제공이력 함께 등록. 실패해도 상담은 이미 저장됐으므로, 입력한 제공 항목은 남겨 두고 따로 알린다.
    let provFailed = false;
    if (provRows.length > 0) {
      const { error: provError } = await supabase.from("provisions").insert(provRows);
      if (provError) {
        provFailed = true;
        toast.error(`상담은 저장됐지만 제공이력 등록은 실패했어요: ${provError.message}. 입력한 제공 항목은 화면에 남겨 두었으니 제공이력 탭에서 등록해 주세요.`);
      } else {
        toast.success(`제공이력 ${provRows.length}건도 함께 등록했어요.`);
      }
    }
    sendingRef.current = false;
    setBusy(false);
    if (!provFailed) {
      setProvOpen(false);
      setProvDrafts([newProvisionDraft()]);
    }
    setCounselTitle("");
    setNote("");
    setCounselResult("");
    setDirection(""); // 이전 방향 메모가 다음 AI 다듬기에 주입되는 버그 방지
    setPreRefine(null);
    setPreRefineTitle(null);
    setPreRefineResult(null);
    setHasRefined(false);
    setCounselDate(new Date().toLocaleDateString("en-CA"));
    setPlanLinkOpen(false);
    setSelectedPlanIds(new Set());
    resetRecording();
    onChanged();
  }

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card">
      {noticeDialog}
      {/* 헤더 */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold truncate"><ClientName c={client} /></span>
          {programsOf(client).map((p) => (
            <Badge key={p} variant="outline" className={`text-[10px] ${programStyle[p] ?? ""}`}>
              {p}
            </Badge>
          ))}
          {hasCareLevel(client) && (
            <Badge variant="outline" className={`${careLevelStyle[careLevelOf(client)] ?? ""}`}>
              {careLevelOf(client)}
            </Badge>
          )}
          <Badge variant="outline" className={`${riskStyle[client.risk] ?? ""}`}>
            {client.risk}
          </Badge>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">담당 {client.worker_name ?? "-"}</span>
          <button
            type="button"
            onClick={() => {
              if (kwOpen) {
                setKwOpen(false);
                setKw("");
              } else {
                setKwOpen(true);
              }
            }}
            className={`inline-flex items-center justify-center h-8 w-8 rounded-md border ${kwOpen ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-accent"}`}
            title="이 어르신 상담기록 검색"
            aria-label="대상자별 상담기록 검색"
          >
            <Search className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 대상자별 상담기록 키워드 검색 (돋보기 클릭 시 표시) */}
      {kwOpen && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <div className="relative flex-1 min-w-0">
            <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder="이 어르신 상담기록에서 검색 (예: 선풍기)"
              className="h-8 pl-8"
              autoFocus
            />
          </div>
          {kw.trim() && (
            <span className="text-[11px] text-muted-foreground shrink-0 whitespace-nowrap">
              {kwStat?.count ?? 0}건
              {kwStat?.last ? ` · 최근 ${kwStat.last.toLocaleDateString("ko-KR")}` : ""}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setKw("");
              setKwOpen(false);
            }}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="검색 닫기"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 기간 필터 (달력으로 시작일·종료일 선택) */}
      {effectiveThread.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border">
          <span className="text-[11px] text-muted-foreground shrink-0">기간</span>
          <Input
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-8 w-[9.5rem]"
            aria-label="시작일"
            title="시작일 (달력으로 선택)"
          />
          <span className="text-muted-foreground">~</span>
          <Input
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setToDate(e.target.value)}
            className="h-8 w-[9.5rem]"
            aria-label="종료일"
            title="종료일 (달력으로 선택)"
          />
          {(fromDate || toDate) && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => {
                setFromDate("");
                setToDate("");
              }}
            >
              전체
            </Button>
          )}
        </div>
      )}

      {/* 대화 스레드 */}
      <div className="overflow-y-auto px-4 py-4 space-y-3 bg-accent/10 min-h-[180px] max-h-[60dvh]">
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-10">
            {effectiveThread.length === 0
              ? "아직 상담기록이 없어요. 아래에 첫 상담 내용을 남겨보세요."
              : kwLower
                ? `'${kw.trim()}' 이(가) 포함된 상담기록이 없습니다.`
                : "선택한 기간에는 상담기록이 없습니다."}
          </p>
        )}
        {items.map(({ l, dateStr, showDate }) => (
          <Fragment key={l.id}>
            {showDate && (
              <div className="flex justify-center py-1">
                <span className="text-[11px] font-medium text-muted-foreground bg-background border border-border rounded-full px-3 py-1">
                  {dateStr}
                </span>
              </div>
            )}
            <div className="group max-w-[85%] rounded-2xl rounded-tl-sm border border-border bg-background px-3.5 py-2.5 shadow-sm">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground mb-1">
                <MethodIcon m={l.method} />
                <span>{l.method}</span>
                <span>· {l.worker_name ?? "-"}</span>
                {l.audio_url && (
                  <a
                    href={l.audio_url}
                    onClick={(e) => { e.preventDefault(); openDriveFile(l.audio_url, "상담 녹음", { kind: "상담 녹음", client }); }}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-blue-500 hover:underline"
                    title="음성녹음 파일 열기"
                  >
                    <FileAudio className="h-3 w-3" />
                    <span>녹음</span>
                  </a>
                )}
                <span className="ml-auto">{formatLogDateTime(l)}</span>
                {editingId !== l.id && (
                  <span className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => printLog(l)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-background hover:bg-accent active:bg-accent"
                      title="상담기록서 출력"
                      aria-label="상담기록서 인쇄"
                    >
                      <Printer className="h-4 w-4" />
                      <span className="hidden sm:inline">인쇄</span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-background hover:bg-accent active:bg-accent"
                          title="항목별 복사"
                          aria-label="상담기록 항목별 복사"
                        >
                          <Copy className="h-4 w-4" />
                          <span className="hidden sm:inline">복사</span>
                          <ChevronDown className="h-3 w-3" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => copyField(l, "title")}>
                          제목 복사
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => copyField(l, "note")}>
                          상담내용 복사
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => copyField(l, "result")}>
                          결과내용 복사
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {canWrite && (
                    <button
                      type="button"
                      onClick={() => startEdit(l)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-background hover:bg-accent active:bg-accent"
                      title="수정"
                      aria-label="상담기록 수정"
                    >
                      <Pencil className="h-4 w-4" />
                      <span className="hidden sm:inline">수정</span>
                    </button>
                    )}
                    {canWrite && (
                    <button
                      type="button"
                      onClick={() => deleteLog(l.id)}
                      disabled={rowBusy === l.id}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-background text-destructive hover:bg-accent active:bg-accent disabled:opacity-50"
                      title="삭제"
                      aria-label="상담기록 삭제"
                    >
                      <Trash2 className="h-4 w-4" />
                      <span className="hidden sm:inline">삭제</span>
                    </button>
                    )}
                  </span>
                )}
              </div>
              {editingId === l.id ? (
                <div className="space-y-2">
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="상담제목 (선택)"
                    className="h-8 text-sm"
                  />
                  <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                    <span className="shrink-0">상담일자</span>
                    <input
                      type="date"
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                      className="h-7 rounded border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    {editHasTime && (
                      <input
                        type="time"
                        value={editTime}
                        onChange={(e) => setEditTime(e.target.value)}
                        className="h-7 rounded border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                        title="상담시간"
                      />
                    )}
                    <span className="shrink-0 ml-2">상담형태</span>
                    <select
                      value={editMethod}
                      onChange={(e) => setEditMethod(e.target.value)}
                      className="h-7 rounded border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      {CONTACT_METHODS.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">상담내용</p>
                    <Textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={5}
                      className="text-sm"
                      autoFocus
                    />
                  </div>
                  {/* AI 다듬기 버튼 + 되돌리기 */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={refineEditNote}
                      disabled={editRefineBusy || editText.trim().length < 5}
                      title="초안을 최근 상담기록 문체로 다듬기"
                    >
                      {editRefineBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                      AI 다듬기
                    </Button>
                    <AiModelBadge model={refineModel} />
                    {editPreRefine !== null && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-8"
                        onClick={() => { setEditText(editPreRefine); setEditPreRefine(null); }}
                        title="다듬기 전 원문으로 되돌리기"
                      >
                        <Undo2 className="h-4 w-4" /> 되돌리기
                      </Button>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">결과내용 (진단 및 대처)</p>
                    <Textarea
                      value={editResult}
                      onChange={(e) => setEditResult(e.target.value)}
                      rows={3}
                      className="text-sm"
                      placeholder="진단 및 대처 내용을 입력하세요. (선택)"
                    />
                  </div>
                  {/* 계획 점검 연동 */}
                  {activePlanActions.length === 0 && programsOf(client).includes("사례관리") && (
                    <p className="text-[11px] text-muted-foreground">
                      사례관리 계획 점검 연동 — 재사정 기록지에 행동계획이 등록되면 활성화됩니다.
                    </p>
                  )}
                  {activePlanActions.length > 0 && (
                    <div className="space-y-1.5">
                      <label className="flex items-center gap-2 cursor-pointer w-fit">
                        <Checkbox
                          checked={editPlanOpen}
                          onCheckedChange={(checked) => {
                            setEditPlanOpen(!!checked);
                            if (!checked) setEditPlanSelectedIds(new Set());
                          }}
                        />
                        <span className="text-sm font-medium">사례관리 계획 점검 연동</span>
                      </label>
                      {editPlanOpen && (
                        <div className="rounded-md border border-border divide-y divide-border max-h-36 overflow-y-auto bg-card">
                          {activePlanActions.some(({ role }) => role === "self") && <div className="px-3 py-0.5 bg-blue-50/60 dark:bg-blue-950/20 text-[10px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide sticky top-0">당사자</div>}
                          {activePlanActions.filter(({ role }) => role === "self").map(({ action }) => (
                            <label key={action.id} className={`flex items-center gap-2.5 px-3 py-1.5 cursor-pointer text-sm hover:bg-muted/40 transition-colors ${editPlanSelectedIds.has(action.id) ? "bg-primary/5" : ""}`}>
                              <Checkbox checked={editPlanSelectedIds.has(action.id)} onCheckedChange={(checked) => { setEditPlanSelectedIds((prev) => { const next = new Set(prev); if (checked) next.add(action.id); else next.delete(action.id); return next; }); }} />
                              <span className="truncate">{action.text}</span>
                              {action.targetCount && <span className="text-[11px] text-muted-foreground shrink-0">목표 {action.targetCount}{action.unit ?? ""}</span>}
                            </label>
                          ))}
                          {activePlanActions.some(({ role }) => role === "worker") && <div className="px-3 py-0.5 bg-violet-50/60 dark:bg-violet-950/20 text-[10px] font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wide sticky top-0">담당자</div>}
                          {activePlanActions.filter(({ role }) => role === "worker").map(({ action }) => (
                            <label key={action.id} className={`flex items-center gap-2.5 px-3 py-1.5 cursor-pointer text-sm hover:bg-muted/40 transition-colors ${editPlanSelectedIds.has(action.id) ? "bg-primary/5" : ""}`}>
                              <Checkbox checked={editPlanSelectedIds.has(action.id)} onCheckedChange={(checked) => { setEditPlanSelectedIds((prev) => { const next = new Set(prev); if (checked) next.add(action.id); else next.delete(action.id); return next; }); }} />
                              <span className="truncate">{action.text}</span>
                              {action.targetCount && <span className="text-[11px] text-muted-foreground shrink-0">목표 {action.targetCount}{action.unit ?? ""}</span>}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {/* 방향 메모 — 첫 다듬기 이후 표시 */}
                  {editHasRefined && (
                    <textarea
                      value={editDirection}
                      onChange={(e) => {
                        setEditDirection(e.target.value);
                        const t = e.target;
                        t.style.height = "auto";
                        t.style.height = Math.min(t.scrollHeight, 200) + "px";
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          refineEditNote();
                        }
                      }}
                      rows={1}
                      placeholder="방향 메모 입력 후 Enter — 더 간결하게, 위기 개입 맥락 추가 등"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      style={{ resize: "none", minHeight: "36px", maxHeight: "200px", overflowY: "auto" }}
                    />
                  )}
                  <div className="flex justify-end gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingId(null)}
                    >
                      <X className="h-4 w-4" /> 취소
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => saveEdit(l.id)}
                      disabled={rowBusy === l.id}
                    >
                      {rowBusy === l.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}{" "}
                      저장
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {l.title && (
                    <p className="text-sm font-semibold">{l.title}</p>
                  )}
                  <p className="text-sm whitespace-pre-wrap">
                    <Highlighted text={l.note ?? ""} kw={kw} />
                  </p>
                  {l.result && (
                    <div className="mt-2 rounded-md bg-muted/50 px-3 py-2">
                      <p className="text-xs text-muted-foreground mb-0.5">결과내용 (진단 및 대처)</p>
                      <p className="text-sm whitespace-pre-wrap">{l.result}</p>
                    </div>
                  )}
                  {/* 사례관리 계획 연동 표시 */}
                  {(linkedByLogId.get(l.id) ?? []).length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1 items-center">
                      <span className="text-[10px] text-muted-foreground shrink-0">계획연동</span>
                      {(linkedByLogId.get(l.id) ?? []).map((aa) => (
                        <span
                          key={aa.action.id}
                          className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20"
                        >
                          {aa.action.text.length > 20 ? aa.action.text.slice(0, 20) + "…" : aa.action.text}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {l.transcript && editingId !== l.id && (
                <TranscriptViewer
                  logId={l.id}
                  transcript={l.transcript}
                  onChanged={onChanged}
                  aiBlocked={isAiBlocked(client)}
                  clientId={client.id}
                />
              )}
            </div>
          </Fragment>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* 입력창 (대화형 컴포저) — 뷰어는 숨김 */}
      {canWrite && <div className="border-t border-border p-3 space-y-2">
        {/* 상담제목 */}
        <Input
          value={counselTitle}
          onChange={(e) => setCounselTitle(e.target.value)}
          placeholder="상담제목 (선택)"
          className="h-8 text-sm"
        />
        {/* 날짜·방법·AI버튼: 좁은 화면에서 자동 줄바꿈 */}
        <div className="flex flex-wrap items-center gap-2">
          {/* 상담일자·시간 선택 */}
          <input
            type="date"
            value={counselDate}
            max={new Date().toLocaleDateString("en-CA")}
            onChange={(e) => setCounselDate(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            title="상담일자 (기본값: 오늘)"
          />
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger className="h-8 w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTACT_METHODS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* 음성녹음 버튼 */}
          {!isRecording && !audioBlobUrl && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              onClick={startRecording}
              title="음성 녹음 시작"
            >
              <Mic className="h-4 w-4" />
              녹음
            </Button>
          )}
          {isRecording && (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="h-8"
              onClick={stopRecording}
              title="녹음 중지"
            >
              <MicOff className="h-4 w-4 animate-pulse" />
              {fmtSec(recordingSec)} 중지
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8"
            onClick={refineNote}
            disabled={refineBusy || note.trim().length < 5}
            title="초안을 최근 상담기록 문체로 다듬기 (제미나이)"
          >
            {refineBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            AI 다듬기
          </Button>
          <AiModelBadge model={refineModel} />
          {preRefine !== null && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={undoRefine}
              title="다듬기 전 원문으로 되돌리기"
            >
              <Undo2 className="h-4 w-4" />
              되돌리기
            </Button>
          )}
        </div>
        {/* 음성녹음 전사 패널 */}
        {(audioBlobUrl || transcribeBusy) && (
          <div className="rounded-lg border border-blue-200 bg-blue-50/60 dark:border-blue-800 dark:bg-blue-950/20 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FileAudio className="h-4 w-4 text-blue-500 shrink-0" />
                <span className="text-sm font-medium text-blue-700 dark:text-blue-300">음성녹음</span>
                {driveAudioUrl && (
                  <a
                    href={driveAudioUrl}
                    onClick={(e) => { e.preventDefault(); openDriveFile(driveAudioUrl, "상담 녹음", { kind: "상담 녹음", client }); }}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-blue-500 hover:underline"
                  >
                    Drive에서 열기
                  </a>
                )}
              </div>
              <button
                type="button"
                onClick={resetRecording}
                className="text-muted-foreground hover:text-foreground"
                title="녹음 초기화"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* 로컬 오디오 플레이어 */}
            {audioBlobUrl && (
              <audio controls src={audioBlobUrl} className="w-full h-8" />
            )}
            {/* 전사 중 */}
            {transcribeBusy && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                AI가 녹음 내용을 텍스트로 변환 중…
                <AiModelBadge />
              </div>
            )}
            {/* 전사 결과 편집 */}
            {!transcribeBusy && rawTranscript && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                  전사 결과 — 오인식된 단어나 표현을 직접 수정한 후 상담내용에 적용하세요.
                  <AiModelBadge model={transcribeModel} />
                </p>
                <Textarea
                  value={rawTranscript}
                  onChange={(e) => setRawTranscript(e.target.value)}
                  rows={4}
                  className="text-sm bg-white dark:bg-background"
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-8"
                  onClick={applyTranscript}
                >
                  <Play className="h-4 w-4" />
                  상담내용에 적용
                </Button>
              </div>
            )}
          </div>
        )}
        <div>
          <p className="text-xs text-muted-foreground mb-1">상담내용</p>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="상담·활동 내용을 입력하세요.  (Ctrl+Enter 전송)"
            rows={5}
            className="resize-y"
            style={{ resize: "vertical", minHeight: "80px", maxHeight: "40dvh" }}
          />
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1">결과내용 (진단 및 대처)</p>
          <Textarea
            value={counselResult}
            onChange={(e) => setCounselResult(e.target.value)}
            placeholder="진단 및 대처 내용을 입력하세요. (선택)"
            rows={3}
            className="resize-y"
            style={{ resize: "vertical", minHeight: "60px", maxHeight: "30dvh" }}
          />
        </div>
        {/* 계획 점검 연동 토글 */}
        {activePlanActions.length === 0 && programsOf(client).includes("사례관리") && (
          <p className="text-[11px] text-muted-foreground">
            사례관리 계획 점검 연동 — 재사정 기록지에 행동계획이 등록되면 활성화됩니다.
          </p>
        )}
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5">
            {activePlanActions.length > 0 && (
              <label className="flex items-center gap-2 cursor-pointer w-fit">
                <Checkbox
                  checked={planLinkOpen}
                  onCheckedChange={(checked) => {
                    setPlanLinkOpen(!!checked);
                    if (!checked) setSelectedPlanIds(new Set());
                  }}
                />
                <span className="text-sm font-medium">사례관리 계획 점검 연동</span>
                <span className="text-xs text-muted-foreground">(선택 안 해도 됨)</span>
              </label>
            )}
            <label className="flex items-center gap-2 cursor-pointer w-fit">
              <Checkbox checked={provOpen} onCheckedChange={(checked) => setProvOpen(!!checked)} />
              <span className="text-sm font-medium">제공이력 함께 등록</span>
              <span className="text-xs text-muted-foreground">(선택 안 해도 됨)</span>
            </label>
          </div>
          {planLinkOpen && (
              <div className="rounded-md border border-border divide-y divide-border max-h-40 overflow-y-auto bg-card">
                {activePlanActions.some(({ role }) => role === "self") && <div className="px-3 py-0.5 bg-blue-50/60 dark:bg-blue-950/20 text-[10px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide sticky top-0">당사자</div>}
                {activePlanActions.filter(({ role }) => role === "self").map(({ action }) => (
                  <label key={action.id} className={`flex items-center gap-2.5 px-3 py-1.5 cursor-pointer text-sm hover:bg-muted/40 transition-colors ${selectedPlanIds.has(action.id) ? "bg-primary/5" : ""}`}>
                    <Checkbox checked={selectedPlanIds.has(action.id)} onCheckedChange={(checked) => { setSelectedPlanIds((prev) => { const next = new Set(prev); if (checked) next.add(action.id); else next.delete(action.id); return next; }); }} />
                    <span className="truncate">{action.text}</span>
                    {action.targetCount && <span className="text-[11px] text-muted-foreground shrink-0">목표 {action.targetCount}{action.unit ?? ""}</span>}
                  </label>
                ))}
                {activePlanActions.some(({ role }) => role === "worker") && <div className="px-3 py-0.5 bg-violet-50/60 dark:bg-violet-950/20 text-[10px] font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wide sticky top-0">담당자</div>}
                {activePlanActions.filter(({ role }) => role === "worker").map(({ action }) => (
                  <label key={action.id} className={`flex items-center gap-2.5 px-3 py-1.5 cursor-pointer text-sm hover:bg-muted/40 transition-colors ${selectedPlanIds.has(action.id) ? "bg-primary/5" : ""}`}>
                    <Checkbox checked={selectedPlanIds.has(action.id)} onCheckedChange={(checked) => { setSelectedPlanIds((prev) => { const next = new Set(prev); if (checked) next.add(action.id); else next.delete(action.id); return next; }); }} />
                    <span className="truncate">{action.text}</span>
                    {action.targetCount && <span className="text-[11px] text-muted-foreground shrink-0">목표 {action.targetCount}{action.unit ?? ""}</span>}
                  </label>
                ))}
              </div>
            )}
          {provOpen && <ProvisionQuickAdd drafts={provDrafts} onChange={setProvDrafts} counselDate={counselDate} />}
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            onClick={send}
            disabled={busy || !note.trim()}
            className="h-10"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            저장
          </Button>
        </div>
        {/* AI 방향 메모: 첫 다듬기 이후 표시, Enter 또는 버튼으로 즉시 재실행 */}
        {hasRefined && (
          <div className="flex items-end gap-2">
            <textarea
              value={direction}
              onChange={(e) => {
                setDirection(e.target.value);
                const t = e.target;
                t.style.height = "auto";
                t.style.height = Math.min(t.scrollHeight, 200) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  refineNote();
                }
              }}
              rows={1}
              placeholder="방향 메모 입력 후 Enter — 자원연계 강조, 더 간결하게, 위기 개입 맥락 추가 등"
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              style={{ resize: "none", minHeight: "36px", maxHeight: "200px", overflowY: "auto" }}
            />
            <Button
              type="button"
              onClick={refineNote}
              disabled={refineBusy || note.trim().length < 5}
              className="h-10 shrink-0"
              title="방향 메모 반영해서 다시 다듬기"
            >
              {refineBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CornerDownLeft className="h-4 w-4" />
              )}
            </Button>
          </div>
        )}
      </div>}
    </div>
  );
}
