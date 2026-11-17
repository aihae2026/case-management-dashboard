import { openDriveFile } from "@/lib/drive-viewer";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AiModelBadge } from "@/components/AiModelBadge";
import { modelFromResponse } from "@/lib/ai-model";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  BookOpen,
  Send,
  Upload,
  FileText,
  Loader2,
  Sparkles,
  User as UserIcon,
  Globe,
  Youtube,
  Plus,
  Trash2,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { uploadTextToDrive, uploadToDrive, readDriveFile } from "@/lib/drive";
import {
  MANUAL_CHUNKS,
  MANUAL_TITLE,
  MANUAL_SUBTITLE,
  MANUAL_PAGES,
  type ManualChunk,
} from "@/lib/manual-data";
import type { OrgRow } from "@/lib/case-types";
import { pickCitedChunks, rankChunks } from "@/lib/manual-search";

const localKey = (orgId: string) => `manual_json_drive_id_${orgId}`;
const localPdfUrlKey = (orgId: string) => `manual_pdf_url_${orgId}`;

// 자료 전체가 이 글자 수 이하면 검색 없이 전부 AI 에 넘긴다(질문과 자료의 표현이 달라 검색이 놓치는 일을 없앤다).
// 넘으면 질문과 관련 높은 조각만 골라 넘긴다.
const FULL_CONTEXT_MAX_CHARS = 120000;

const EXAMPLES = [
  "초기상담은 어떻게 진행하나요?",
  "위기 개입 기준이 뭔가요?",
  "종결 조건 알려줘",
  "재사정은 언제 하나요?",
];

type Meta = {
  title: string;
  subtitle: string;
  pages: number;
  source: "기본" | "업로드";
  updatedAt?: string;
};

type AnyChunk = ManualChunk & {
  sourceId: string;
  sourceTitle: string;
  sourceType: string;
  sourceUrl?: string;
};

type SourceRef = {
  sourceId: string;
  page: number;
  sourceTitle: string;
  sourceType: string;
  sourceUrl?: string;
};

type Msg = { role: "user" | "ai"; text: string; sources?: SourceRef[]; /** 이 답변을 실제로 만든 AI 모델 */ model?: string | null };

type ExtraSource = {
  id: string;
  type: "pdf" | "url" | "youtube";
  title: string;
  url?: string;
  driveUrl?: string; // PDF 원본 Drive URL
  chunks: ManualChunk[];
  createdAt?: string;
};

type AddType = "url" | "youtube" | "pdf";

async function extractPdf(file: File): Promise<ManualChunk[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const chunks: ManualChunk[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) chunks.push({ page: i, text });
  }
  return chunks;
}

function sourceIcon(type: string, className = "h-4 w-4 shrink-0") {
  if (type === "youtube") return <Youtube className={`${className} text-red-500`} />;
  if (type === "url") return <Globe className={`${className} text-blue-500`} />;
  return <FileText className={`${className} text-muted-foreground`} />;
}

export function ManualTab({ org }: { org: OrgRow | null }) {
  // --- 기본 매뉴얼 상태 (기존 로직 유지) ---
  const [chunks, setChunks] = useState<ManualChunk[]>(MANUAL_CHUNKS);
  const [meta, setMeta] = useState<Meta>({
    title: MANUAL_TITLE,
    subtitle: MANUAL_SUBTITLE,
    pages: MANUAL_PAGES,
    source: "기본",
  });
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [viewRef, setViewRef] = useState<SourceRef | null>(null);
  const [manualPdfUrl, setManualPdfUrl] = useState<string | null>(null);

  // --- 추가 참고자료 상태 ---
  const [extraSources, setExtraSources] = useState<ExtraSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addType, setAddType] = useState<AddType>("url");
  const [addUrl, setAddUrl] = useState("");
  const [addTitle, setAddTitle] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const addFileRef = useRef<HTMLInputElement>(null);

  // Drive에 저장된 개정 매뉴얼 불러오기
  useEffect(() => {
    if (!org) return;
    // 원본 PDF URL 복원
    const savedPdfUrl = localStorage.getItem(localPdfUrlKey(org.id));
    if (savedPdfUrl) setManualPdfUrl(savedPdfUrl);
    const driveId = localStorage.getItem(localKey(org.id));
    if (!driveId) return;
    (async () => {
      try {
        const text = await readDriveFile(supabase, driveId);
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.chunks) && parsed.chunks.length) {
          setChunks(parsed.chunks);
          setMeta({
            title: parsed.title || "개정 매뉴얼",
            subtitle: parsed.subtitle || "",
            pages: parsed.pages || parsed.chunks.length,
            source: "업로드",
            updatedAt: parsed.updatedAt,
          });
        }
      } catch {
        // 손상 파일 무시 → 기본 매뉴얼 사용
      }
    })();
  }, [org]);

  // DB에서 추가 참고자료 로드
  useEffect(() => {
    if (!org) return;
    setSourcesLoading(true);
    supabase
      .from("manual_sources")
      .select("id, type, title, url, drive_url, chunks, created_at")
      .eq("org_id", org.id)
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        setExtraSources(
          (data ?? []).map((r) => ({
            id: r.id,
            type: r.type as ExtraSource["type"],
            title: r.title,
            url: r.url ?? undefined,
            driveUrl: (r as Record<string, unknown>).drive_url as string | undefined,
            chunks: (Array.isArray(r.chunks) ? r.chunks : []) as ManualChunk[],
            createdAt: r.created_at ?? undefined,
          })),
        );
        setSourcesLoading(false);
        setSourcesLoaded(true);
      });
  }, [org?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  // 기본 + 추가 청크 통합
  const allChunks = useMemo<AnyChunk[]>(() => {
    const builtin: AnyChunk[] = chunks.map((c) => ({
      ...c,
      sourceId: "builtin",
      sourceTitle: meta.title,
      sourceType: "pdf",
    }));
    const extra: AnyChunk[] = extraSources.flatMap((s) =>
      s.chunks.map((c) => ({
        ...c,
        sourceId: s.id,
        sourceTitle: s.title,
        sourceType: s.type,
        sourceUrl: s.url,
      })),
    );
    return [...builtin, ...extra];
  }, [chunks, extraSources, meta.title]);

  const hasExtra = extraSources.length > 0;
  // 내장 매뉴얼은 없고(내부 문서), 참고자료도 하나도 없으면 추가 안내를 보여 준다
  const hasBuiltin = chunks.length > 0;
  const noManual = sourcesLoaded && !sourcesLoading && !hasBuiltin && !hasExtra;

  const SYSTEM_PROMPT = hasExtra
    ? `당신은 사회복지 업무 안내 도우미예요. 아래 [참고자료] 내용을 근거로 친근하게 답해주세요.\n` +
      "규칙:\n" +
      "1) 참고자료에 있는 내용만 사용하고, 없으면 \"관련 내용을 찾지 못했어요\"라고 솔직하게 말해요.\n" +
      "2) 근거 출처를 (출처명 ○페이지) 형태로 표기해요.\n" +
      "3) 짧고 이해하기 쉽게 핵심만 정리하고, 불릿(•)을 활용해요.\n" +
      "4) ** 같은 마크다운 굵기 표시는 절대 사용하지 마세요. 일반 텍스트만 써요.\n" +
      "5) 딱딱하지 않게, 실무자에게 친근하게 말하는 말투로 답해요. (~해요, ~있어요, ~됩니다 체)\n" +
      "6) 질문의 용어가 자료에는 다른 말로 적혀 있을 수 있어요(예: 초기상담 ↔ 초기면접). 같은 뜻의 내용을 찾아 답하고, 자료에 적힌 표현이 무엇인지 함께 알려 주세요."
    : `당신은 「${meta.title || "업무 매뉴얼"}」 안내 도우미예요. 아래 [매뉴얼] 내용만 근거로 친근하게 답해주세요.\n` +
      "규칙:\n" +
      "1) 매뉴얼에 있는 내용만 사용하고, 없으면 \"매뉴얼에서 관련 내용을 찾지 못했어요\"라고 솔직하게 말해요.\n" +
      "2) 근거가 된 부분의 페이지를 (○페이지)로 표기해요.\n" +
      "3) 짧고 이해하기 쉽게 핵심만 정리하고, 불릿(•)을 활용해요.\n" +
      "4) ** 같은 마크다운 굵기 표시는 절대 사용하지 마세요. 일반 텍스트만 써요.\n" +
      "5) 딱딱하지 않게, 실무자에게 친근하게 말하는 말투로 답해요. (~해요, ~있어요, ~됩니다 체)\n" +
      "6) 질문의 용어가 자료에는 다른 말로 적혀 있을 수 있어요(예: 초기상담 ↔ 초기면접). 같은 뜻의 내용을 찾아 답하고, 자료에 적힌 표현이 무엇인지 함께 알려 주세요.";

  async function send(text?: string) {
    const question = (text ?? input).trim();
    if (question.length < 2) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: question }]);
    setBusy(true);
    // 자료가 작으면 전부 넘기고, 크면 관련 높은 24개 조각만 넘긴다
    const totalChars = allChunks.reduce((sum, c) => sum + Math.min(c.text.length, 2000), 0);
    const passages = totalChars <= FULL_CONTEXT_MAX_CHARS ? allChunks : rankChunks(allChunks, question, 24);
    try {
      const contextLabel = hasExtra ? "[참고자료]" : "[매뉴얼]";
      const manual = passages
        .map((c) => {
          const prefix = hasExtra ? `[${c.sourceTitle} · ${c.page}페이지]` : `[${c.page}페이지]`;
          return `${prefix}\n${c.text.slice(0, 2000)}`;
        })
        .join("\n\n");
      const { data, error } = await supabase.functions.invoke("gemini", {
        body: {
          system: SYSTEM_PROMPT + `\n\n${contextLabel}\n${manual}`,
          user: question,
        },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      const raw: string = data?.text || "관련 내용을 찾지 못했어요.";
      const answer = raw.replace(/\*\*/g, "");
      // 출처 칩: AI 가 답변에 적은 '○페이지'를 우선 쓰고, 읽지 못하면 질문과 관련 높은 순으로 보여 준다
      const cited = pickCitedChunks(answer, passages);
      const sourcePool = cited.length > 0 ? cited : rankChunks(passages, question, 6);
      const sources: SourceRef[] = sourcePool.slice(0, 6).map((p) => ({
        sourceId: p.sourceId,
        page: p.page,
        sourceTitle: p.sourceTitle,
        sourceType: p.sourceType,
        sourceUrl: p.sourceUrl,
      }));
      setMessages((m) => [...m, { role: "ai", text: answer, sources, model: modelFromResponse(data) }]);
    } catch (e) {
      const msg = (e as Error).message || "";
      toast.error("AI 오류: " + (msg.slice(0, 120) || "알 수 없는 오류"));
      const note = /GEMINI_API_KEY missing/.test(msg)
        ? "제미나이 키가 설정되면 AI 답변을 받을 수 있어요. 아래 관련 페이지를 참고하세요."
        : `AI 답변에 실패했어요 (${msg.slice(0, 60) || "오류"}). 아래 관련 내용을 참고하세요.`;
      const sources: SourceRef[] = rankChunks(allChunks, question, 4).map((p) => ({
        sourceId: p.sourceId,
        page: p.page,
        sourceTitle: p.sourceTitle,
        sourceType: p.sourceType,
        sourceUrl: p.sourceUrl,
      }));
      setMessages((m) => [...m, { role: "ai", text: note, sources }]);
    }
    setBusy(false);
  }

  // 개정 PDF 업로드 (기존 기능)
  async function uploadManual(file: File) {
    if (!org) return toast.error("기관 정보를 불러오는 중입니다. 잠시 후 다시 시도하세요.");
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf")
      return toast.error("PDF 파일만 업로드할 수 있어요.");
    setUploading(true);
    const tid = toast.loading("PDF에서 매뉴얼 텍스트 추출 중...");
    try {
      const newChunks = await extractPdf(file);
      if (newChunks.length === 0) {
        toast.error("PDF에서 글자를 읽지 못했어요(스캔 이미지일 수 있어요). 텍스트 PDF를 올려주세요.", {
          id: tid,
        });
        setUploading(false);
        return;
      }
      const payload = {
        title: file.name.replace(/\.pdf$/i, ""),
        subtitle: `개정 업로드 · ${new Date().toLocaleDateString("ko-KR")}`,
        pages: newChunks.length,
        updatedAt: new Date().toISOString(),
        chunks: newChunks,
      };
      toast.loading("Google Drive에 매뉴얼 저장 중...", { id: tid });
      const { id: jsonDriveId } = await uploadTextToDrive(supabase, {
        name: `manual_${org.id}.json`,
        text: JSON.stringify(payload),
        folderName: "매뉴얼",
      });
      localStorage.setItem(localKey(org.id), jsonDriveId);
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const { url: pdfUrl } = await uploadToDrive(supabase, {
          name: file.name,
          mimeType: "application/pdf",
          data: btoa(binary),
          folderName: "매뉴얼",
        });
        if (pdfUrl) {
          localStorage.setItem(localPdfUrlKey(org.id), pdfUrl);
          setManualPdfUrl(pdfUrl);
        }
      } catch {
        // 원본 PDF Drive 업로드 실패 시 무시
      }
      setChunks(newChunks);
      setMeta({
        title: payload.title,
        subtitle: payload.subtitle,
        pages: payload.pages,
        source: "업로드",
        updatedAt: payload.updatedAt,
      });
      setMessages([]);
      toast.success(`개정 매뉴얼이 반영되었어요 (${newChunks.length}페이지).`, { id: tid });
    } catch (e) {
      toast.error("업로드 실패: " + ((e as Error).message || "알 수 없는 오류"), { id: tid });
    }
    setUploading(false);
  }

  // URL / YouTube 참고자료 추가
  async function addUrlSource() {
    if (!org) return;
    const url = addUrl.trim();
    if (!url) return toast.error("URL을 입력해주세요.");
    setAddBusy(true);
    const tid = toast.loading("참고자료 내용을 가져오는 중...");
    try {
      const { data, error } = await supabase.functions.invoke("fetch-url", {
        body: { url },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      const title = addTitle.trim() || data.title || url;
      const { data: row, error: dbErr } = await supabase
        .from("manual_sources")
        .insert({ org_id: org.id, type: addType, title, url, chunks: data.chunks })
        .select("id, type, title, url, chunks, created_at")
        .single();
      if (dbErr) throw new Error(dbErr.message);
      setExtraSources((prev) => [
        ...prev,
        {
          id: row.id,
          type: row.type as ExtraSource["type"],
          title: row.title,
          url: row.url ?? undefined,
          chunks: (Array.isArray(row.chunks) ? row.chunks : []) as ManualChunk[],
          createdAt: row.created_at ?? undefined,
        },
      ]);
      setAddOpen(false);
      setAddUrl("");
      setAddTitle("");
      toast.success(`"${title}" 참고자료가 추가됐어요.`, { id: tid });
    } catch (e) {
      toast.error("추가 실패: " + (e as Error).message, { id: tid });
    }
    setAddBusy(false);
  }

  // PDF 참고자료 추가 (기본 매뉴얼 교체 아님 — 추가 자료)
  async function addPdfSource(file: File) {
    if (!org) return;
    setAddBusy(true);
    const tid = toast.loading("PDF에서 텍스트 추출 중...");
    try {
      const newChunks = await extractPdf(file);
      if (!newChunks.length) throw new Error("PDF에서 텍스트를 읽지 못했어요 (스캔 이미지 PDF는 지원 안 돼요).");
      const title = addTitle.trim() || file.name.replace(/\.pdf$/i, "");

      // 원칙: 원본 파일은 Google Drive에 저장
      let driveId: string | null = null;
      let driveUrl: string | null = null;
      try {
        toast.loading("Google Drive에 저장 중...", { id: tid });
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const result = await uploadToDrive(supabase, {
          name: file.name,
          mimeType: "application/pdf",
          data: btoa(binary),
          folderName: "매뉴얼",
        });
        driveId = result.id;
        driveUrl = result.url;
      } catch {
        // Drive 업로드 실패 시 텍스트만 DB에 저장 (AI 기능은 유지)
      }

      toast.loading("참고자료 저장 중...", { id: tid });
      const { data: row, error: dbErr } = await supabase
        .from("manual_sources")
        .insert({ org_id: org.id, type: "pdf", title, chunks: newChunks, drive_id: driveId, drive_url: driveUrl })
        .select("id, type, title, url, drive_url, chunks, created_at")
        .single();
      if (dbErr) throw new Error(dbErr.message);
      setExtraSources((prev) => [
        ...prev,
        { id: row.id, type: "pdf", title, chunks: newChunks, driveUrl: driveUrl ?? undefined, createdAt: row.created_at ?? undefined },
      ]);
      setAddOpen(false);
      setAddTitle("");
      toast.success(`"${title}" PDF가 추가됐어요.`, { id: tid });
    } catch (e) {
      toast.error("추가 실패: " + (e as Error).message, { id: tid });
    }
    setAddBusy(false);
  }

  async function deleteSource(id: string, title: string) {
    if (!confirm(`"${title}" 참고자료를 삭제할까요?`)) return;
    const { error } = await supabase.from("manual_sources").delete().eq("id", id);
    if (error) return toast.error("삭제 실패: " + error.message);
    setExtraSources((prev) => prev.filter((s) => s.id !== id));
    toast.success("참고자료가 삭제됐어요.");
  }

  const pageText = (p: number) =>
    chunks.find((c) => c.page === p)?.text ?? "해당 페이지 내용을 찾을 수 없습니다.";

  // 소스 칩 클릭 핸들러
  function handleSourceChip(ref: SourceRef) {
    if (ref.sourceType === "url" || ref.sourceType === "youtube") {
      if (ref.sourceUrl) window.open(ref.sourceUrl, "_blank", "noopener");
    } else {
      setViewRef(ref);
    }
  }

  return (
    <div className="space-y-3">
      {/* ── 참고자료 패널 ───────────────────────── */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {/* 헤더 */}
        <button
          type="button"
          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm font-medium hover:bg-accent/30 transition-colors"
          onClick={() => setSourcesOpen((v) => !v)}
        >
          <Sparkles className="h-4 w-4 text-primary shrink-0" />
          <span className="flex-1 text-left">
            참고자료{" "}
            <span className="text-xs font-normal text-muted-foreground">
              {(hasBuiltin ? 1 : 0) + extraSources.length}개
            </span>
          </span>
          {sourcesLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {sourcesOpen ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </button>

        {sourcesOpen && (
          <div className="border-t border-border divide-y divide-border">
            {/* 기본 매뉴얼(개정본 업로드가 있는 브라우저에서만 표시) */}
            {hasBuiltin && (
            <div className="flex items-center gap-2 px-3 py-2 text-sm">
              <BookOpen className="h-4 w-4 shrink-0 text-primary" />
              <span className="flex-1 truncate font-medium">{meta.title}</span>
              <span className="text-xs text-muted-foreground shrink-0">
                {meta.pages}p
                {meta.updatedAt && (
                  <> · {new Date(meta.updatedAt).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })} 업로드</>
                )}
              </span>
              {meta.source === "업로드" && (
                <Badge variant="outline" className="text-[10px] border-primary text-primary shrink-0">
                  개정본
                </Badge>
              )}
              {meta.source === "업로드" && manualPdfUrl && (
                <a
                  href={manualPdfUrl}
                  onClick={(e) => { e.preventDefault(); openDriveFile(manualPdfUrl, "매뉴얼 원본 PDF"); }}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-muted-foreground hover:text-primary"
                  title="원본 PDF 열기"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              <label className="shrink-0 text-xs inline-flex items-center gap-1 cursor-pointer rounded border border-border px-2 h-7 hover:bg-accent ml-1">
                {uploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                개정 PDF
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => {
                    if (e.target.files?.[0]) uploadManual(e.target.files[0]);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            )}

            {/* 추가 참고자료 목록 */}
            {extraSources.map((src) => (
              <div key={src.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                {sourceIcon(src.type)}
                <span className="flex-1 truncate">{src.title}</span>
                {src.createdAt && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {new Date(src.createdAt).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })} 추가
                  </span>
                )}
                {src.url && (
                  <a
                    href={src.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-muted-foreground hover:text-primary"
                    title="원본 열기"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                {src.type === "pdf" && src.driveUrl && (
                  <a
                    href={src.driveUrl}
                    onClick={(e) => { e.preventDefault(); openDriveFile(src.driveUrl, "매뉴얼 원본 PDF"); }}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-muted-foreground hover:text-primary"
                    title="원본 PDF 열기"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => deleteSource(src.id, src.title)}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  title="삭제"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            {/* 추가 버튼 */}
            <div className="px-3 py-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setAddType("url");
                  setAddUrl("");
                  setAddTitle("");
                  setAddOpen(true);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                참고자료 추가 (뉴스기사 · YouTube · PDF)
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── 채팅 영역 ───────────────────────────── */}
      <div className="flex flex-col h-[54dvh] lg:h-[60vh] rounded-lg border border-border bg-card">
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-accent/10">
          {noManual && (
            <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground gap-3">
              <BookOpen className="h-8 w-8 opacity-40" />
              <p className="text-sm">
                업무에 참고할 매뉴얼을 추가해 주세요.
                <br />
                PDF·뉴스 기사·YouTube 링크를 올리면 그 내용을 근거로 답해 드려요.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => {
                  setAddType("pdf");
                  setAddUrl("");
                  setAddTitle("");
                  setAddOpen(true);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                참고자료 추가
              </Button>
            </div>
          )}
          {!noManual && messages.length === 0 && !busy && (
            <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground gap-3">
              <Sparkles className="h-8 w-8 opacity-40" />
              <p className="text-sm">
                매뉴얼 및 참고자료에 대해 궁금한 것을 대화형으로 물어보세요.
                <br />
                답변에 인용된 출처를 눌러 원문을 볼 수 있어요.
              </p>
              <div className="flex flex-wrap justify-center gap-1.5 max-w-md">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => send(ex)}
                    className="text-xs rounded-full border border-border px-2.5 py-1 hover:bg-accent transition-colors"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-3.5 py-2 text-sm">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[88%] rounded-2xl rounded-tl-sm border border-border bg-background px-3.5 py-2.5 shadow-sm">
                  <div className="flex items-center gap-1 text-[11px] font-medium text-primary mb-1">
                    <Sparkles className="h-3 w-3" /> 매뉴얼 도우미
                    {m.model && <AiModelBadge model={m.model} className="ml-1" />}
                  </div>
                  <p className="text-sm whitespace-pre-wrap leading-relaxed">{m.text}</p>
                  {(m.sources?.length ?? 0) > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      <span className="text-[11px] text-muted-foreground">참고 출처</span>
                      {m.sources!.map((ref, ri) => (
                        <button
                          key={ri}
                          type="button"
                          onClick={() => handleSourceChip(ref)}
                          title={
                            ref.sourceType === "url" || ref.sourceType === "youtube"
                              ? "원본 열기"
                              : "원문 보기"
                          }
                          className="inline-flex items-center gap-0.5 text-[11px] rounded-full border border-border px-2 py-0.5 hover:bg-accent"
                        >
                          {ref.sourceType === "youtube" ? (
                            <Youtube className="h-3 w-3 text-red-500" />
                          ) : ref.sourceType === "url" ? (
                            <Globe className="h-3 w-3 text-blue-500" />
                          ) : (
                            <FileText className="h-3 w-3" />
                          )}
                          {hasExtra ? (
                            <span className="max-w-[80px] truncate">{ref.sourceTitle}</span>
                          ) : null}
                          {ref.sourceType !== "youtube" || !ref.sourceUrl ? (
                            <span>{ref.page}p</span>
                          ) : null}
                          {(ref.sourceType === "url" || ref.sourceType === "youtube") && (
                            <ExternalLink className="h-2.5 w-2.5 opacity-50" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ),
          )}

          {busy && (
            <div className="flex justify-start">
              <div className="rounded-2xl rounded-tl-sm border border-border bg-background px-3.5 py-2.5 text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> 참고자료를 근거로 답변 작성 중...
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* 입력창 */}
        <div className="border-t border-border p-3">
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={noManual ? "참고자료를 먼저 추가해 주세요." : "매뉴얼 또는 참고자료에 대해 질문하세요. (Enter 전송 · Shift+Enter 줄바꿈)"}
              disabled={noManual}
              rows={2}
              className="resize-none"
            />
            <Button
              type="button"
              onClick={() => send()}
              disabled={busy || noManual || input.trim().length < 2}
              className="h-10 shrink-0"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            <UserIcon className="h-3 w-3 inline mr-0.5" />
            답변은 등록된 참고자료 내용만 근거로 제공돼요.
          </p>
        </div>
      </div>

      {/* ── 참고자료 추가 다이얼로그 ──────────────── */}
      <Dialog open={addOpen} onOpenChange={(v) => { if (!v && !addBusy) setAddOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>참고자료 추가</DialogTitle>
            <DialogDescription>
              뉴스기사, YouTube 영상, PDF 파일을 추가하면 매뉴얼과 함께 AI 답변에 활용돼요.
            </DialogDescription>
          </DialogHeader>

          {/* 타입 선택 */}
          <div className="flex gap-2">
            {(
              [
                { key: "url", label: "웹 URL", Icon: Globe },
                { key: "youtube", label: "YouTube", Icon: Youtube },
                { key: "pdf", label: "PDF", Icon: FileText },
              ] as { key: AddType; label: string; Icon: React.FC<any> }[]
            ).map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setAddType(key)}
                className={`flex-1 flex flex-col items-center gap-1 py-2.5 rounded-lg border text-xs font-medium transition-colors ${
                  addType === key
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:bg-accent"
                }`}
              >
                <Icon className="h-5 w-5" />
                {label}
              </button>
            ))}
          </div>

          {/* 입력 영역 */}
          <div className="space-y-2.5">
            {addType !== "pdf" && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  {addType === "youtube" ? "YouTube URL" : "URL (뉴스기사 링크 등)"}
                </label>
                <Input
                  value={addUrl}
                  onChange={(e) => setAddUrl(e.target.value)}
                  placeholder={
                    addType === "youtube"
                      ? "https://www.youtube.com/watch?v=..."
                      : "https://news.example.com/..."
                  }
                  disabled={addBusy}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addUrlSource();
                  }}
                />
              </div>
            )}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">제목 (선택, 비우면 자동 추출)</label>
              <Input
                value={addTitle}
                onChange={(e) => setAddTitle(e.target.value)}
                placeholder="예: 2024년 사회복지 지침"
                disabled={addBusy}
              />
            </div>

            {addType === "pdf" && (
              <label className="flex items-center justify-center gap-2 h-20 rounded-lg border-2 border-dashed border-border cursor-pointer hover:bg-accent/50 transition-colors text-sm text-muted-foreground">
                {addBusy ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <>
                    <Upload className="h-5 w-5" />
                    PDF 파일 선택
                  </>
                )}
                <input
                  ref={addFileRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  className="hidden"
                  disabled={addBusy}
                  onChange={(e) => {
                    if (e.target.files?.[0]) addPdfSource(e.target.files[0]);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </div>

          {addType !== "pdf" && (
            <Button
              type="button"
              onClick={addUrlSource}
              disabled={addBusy || !addUrl.trim()}
              className="w-full"
            >
              {addBusy ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-1" /> 가져오는 중...</>
              ) : (
                "참고자료 추가"
              )}
            </Button>
          )}
        </DialogContent>
      </Dialog>

      {/* ── 페이지 원문 보기 (PDF/매뉴얼만) ──────── */}
      <Dialog open={viewRef !== null} onOpenChange={(v) => !v && setViewRef(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <FileText className="h-4 w-4 text-primary" />
              {viewRef?.sourceTitle} · {viewRef?.page}페이지
            </DialogTitle>
            <DialogDescription>매뉴얼 원문</DialogDescription>
          </DialogHeader>
          <p className="text-sm whitespace-pre-wrap leading-relaxed">
            {viewRef !== null
              ? viewRef.sourceId === "builtin"
                ? pageText(viewRef.page)
                : extraSources
                    .find((s) => s.id === viewRef.sourceId)
                    ?.chunks.find((c) => c.page === viewRef.page)?.text ??
                  "내용을 찾을 수 없습니다."
              : ""}
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
