import { openDriveFile } from "@/lib/drive-viewer";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AiModelBadge } from "@/components/AiModelBadge";
import { useServerFn } from "@tanstack/react-start";
import { analyzeReassessment, extractCarePlan, type ReassessMeta } from "@/lib/ai.functions";
import type { CarePlan } from "@/lib/case-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
// PDF 텍스트 추출 워커 (클라이언트에서만 실행)
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
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
import { toast } from "sonner";
import { AI_REFUSED_MESSAGE, isAiBlocked } from "@/lib/ai-consent";
import {
  ClipboardCheck,
  Pencil,
  Plus,
  Trash2,
  Loader2,
  Target,
  Upload,
  FileText,
  X,
} from "lucide-react";
import {
  splitNote,
  joinNote,
  type Client,
  type Reassessment,
  type ReassessFamily,
  type ReassessAiAnalysis,
  type ReassessNeed,
  type Goal,
} from "@/lib/case-types";
import { Sparkles, Link2, TrendingUp, AlertTriangle, ListChecks, ChevronDown } from "lucide-react";
import { GoalReflectDialog } from "./GoalReflectDialog";
import {
  Line,
  LineChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
  Legend,
} from "recharts";

const METHODS = ["내방", "방문", "전화"];

// YYYY-MM-DD 형식인지
const isYmd = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

// AI 오류 메시지를 사람이 읽기 쉽게 변환 (원본 JSON 노출 방지)
function aiErrorMessage(msg: string): string {
  if (/GEMINI_API_KEY missing/.test(msg)) return "제미나이 키가 필요합니다.";
  if (/\b429\b|quota|rate.?limit|exceeded/i.test(msg))
    return "제미나이 무료 사용량(quota)을 초과했어요. 1~2분 뒤 또는 내일 다시 시도해 주세요. 사용량이 많으면 Google AI Studio에서 결제를 설정하면 한도가 크게 늘어납니다.";
  return "AI 분석 실패: " + msg;
}

// AI가 추출한 meta에서 척도(scales) 객체를 만든다. 값이 하나도 없으면 undefined.
function scalesFromMeta(m?: ReassessMeta): Reassessment["scales"] | undefined {
  if (!m) return undefined;
  const sc: NonNullable<Reassessment["scales"]> = {};
  if (m.sgdsTotal) sc.sgdsTotal = m.sgdsTotal;
  if (m.sgdsResult) sc.sgdsResult = m.sgdsResult;
  if (m.sgdsOpinion) sc.sgdsOpinion = m.sgdsOpinion;
  if (m.mspssAgency) sc.mspssAgency = m.mspssAgency;
  if (m.mspssFriend) sc.mspssFriend = m.mspssFriend;
  if (m.mspssOther) sc.mspssOther = m.mspssOther;
  if (m.mspssOpinion) sc.mspssOpinion = m.mspssOpinion;
  return Object.keys(sc).length ? sc : undefined;
}

// PDF에서 텍스트 추출 (브라우저)
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
      content.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return parts.filter(Boolean).join("\n");
}

// 저장된(Storage) PDF를 내려받아 텍스트 추출 — [AI 분석] 재시도용
async function extractStoredPdfText(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 120);
  if (error || !data) throw new Error("파일에 접근할 수 없습니다.");
  const res = await fetch(data.signedUrl);
  const blob = await res.blob();
  return extractPdfText(new File([blob], "reassess.pdf", { type: "application/pdf" }));
}

// 재사정 기록을 AI 분석용 텍스트로 직렬화
function reassessToText(r: Reassessment): string {
  const c = r.changes ?? {};
  const lines: string[] = [];
  if (r.reassessType) lines.push(`재사정 유형: ${r.reassessType}`);
  if (r.reassessFactor) lines.push(`재사정 요인: ${r.reassessFactor}`);
  if (c.physical) lines.push(`신체적 변화: ${c.physical}`);
  if (c.psychological) lines.push(`심리적 변화: ${c.psychological}`);
  if (c.economic) lines.push(`경제적 변화: ${c.economic}`);
  if (c.social) lines.push(`사회적 관계망: ${c.social}`);
  if (c.etc) lines.push(`기타: ${c.etc}`);
  if (r.scales?.sgds) lines.push(`우울(SGDS): ${r.scales.sgds}`);
  if (r.scales?.mspss) lines.push(`사회지지(MSPSS): ${r.scales.mspss}`);
  (r.evaluation?.items ?? []).forEach((it) =>
    lines.push(`평가: ${it.need} / ${it.goal} / ${it.content} / 달성 ${it.achievement}`),
  );
  (r.plan ?? []).forEach((it) =>
    lines.push(`계획: 문제 ${it.problem} / 욕구 ${it.need} / ${it.action} / 우선 ${it.priority}`),
  );
  if (r.workerOpinion) lines.push(`사회복지사 의견: ${r.workerOpinion}`);
  return lines.join("\n");
}
const RESULTS = ["서비스 재계획 및 계약", "의뢰", "종결"];
const REASSESS_TYPES = ["새로운 욕구가 발생", "긴급한 상황이 발생", "정기적인 서비스 점검"];

// ── 변화 추이(척도 점수) 파싱 ─────────────────────────
/** 문자열에서 첫 숫자를 뽑는다. (예: "SGDS 10점, 우울증 의심" → 10) */
function firstNumber(s?: string): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
/** 우울척도(SGDS) 점수: 총점 필드 우선, 없으면 자유텍스트에서 추출. */
function sgdsScore(r: Reassessment): number | null {
  return firstNumber(r.scales?.sgdsTotal) ?? firstNumber(r.scales?.sgds);
}
/** 사회지지(MSPSS) 점수: 하위영역 합, 없으면 자유텍스트에서 추출. */
function mspssScore(r: Reassessment): number | null {
  const parts = [r.scales?.mspssAgency, r.scales?.mspssFriend, r.scales?.mspssOther]
    .map(firstNumber)
    .filter((n): n is number => n != null);
  if (parts.length) return parts.reduce((a, b) => a + b, 0);
  return firstNumber(r.scales?.mspss);
}

/** 재사정이 2건 이상일 때 우울·사회지지 점수 변화와 항목 비교표를 보여준다. */
function ReassessTrend({ all }: { all: Reassessment[] }) {
  const ordered = [...all]
    .filter((r) => r.reassessedAt)
    .sort((a, b) => (a.reassessedAt ?? "").localeCompare(b.reassessedAt ?? ""));
  const rows = ordered.map((r) => ({
    date: r.reassessedAt ?? "",
    label: (r.reassessedAt ?? "").slice(2), // YY-MM-DD
    우울: sgdsScore(r),
    지지: mspssScore(r),
    type: r.reassessType ?? "",
    result: r.result ?? "",
    needs: r.aiAnalysis?.needs?.length ?? 0,
  }));
  const hasDepr = rows.some((x) => x.우울 != null);
  const hasSupp = rows.some((x) => x.지지 != null);

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-3">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-primary">
        <TrendingUp className="h-4 w-4" /> 재사정 변화 추이 ({ordered.length}회)
      </div>

      {hasDepr || hasSupp ? (
        <>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={rows} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                fontSize={11}
                width={28}
              />
              <RTooltip
                contentStyle={{
                  background: "var(--background)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {hasDepr && (
                <Line
                  type="monotone"
                  dataKey="우울"
                  name="우울(SGDS)"
                  stroke="var(--chart-1)"
                  strokeWidth={2}
                  connectNulls
                  dot={{ r: 3 }}
                />
              )}
              {hasSupp && (
                <Line
                  type="monotone"
                  dataKey="지지"
                  name="사회지지(MSPSS)"
                  stroke="var(--chart-2)"
                  strokeWidth={2}
                  connectNulls
                  dot={{ r: 3 }}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
          <p className="text-[11px] text-muted-foreground">
            우울(SGDS)은 낮을수록, 사회지지(MSPSS)는 높을수록 좋아요. 점수는 척도 입력값에서 자동
            추출됩니다.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          척도(SGDS·MSPSS) 점수가 입력되면 여기에 변화 그래프가 나타납니다.
        </p>
      )}

      {/* 회차별 비교표 */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground border-b">
            <tr className="text-left">
              <th className="py-1 pr-2">일시</th>
              <th className="py-1 pr-2">유형</th>
              <th className="py-1 pr-2">우울</th>
              <th className="py-1 pr-2">지지</th>
              <th className="py-1 pr-2">욕구수</th>
              <th className="py-1">결과</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x, i) => (
              <tr key={i} className="border-b border-border last:border-0 align-top">
                <td className="py-1 pr-2 whitespace-nowrap font-medium">{x.date}</td>
                <td className="py-1 pr-2">{x.type || "-"}</td>
                <td className="py-1 pr-2 whitespace-nowrap">{x.우울 ?? "-"}</td>
                <td className="py-1 pr-2 whitespace-nowrap">{x.지지 ?? "-"}</td>
                <td className="py-1 pr-2 whitespace-nowrap">{x.needs || "-"}</td>
                <td className="py-1">{x.result || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Props = { client: Client; onChanged: () => void };

const BUCKET = "reassessment-files";

export function ReassessmentTab({ client, onChanged }: Props) {
  const all = splitNote(client.note).reassessments;
  const [open, setOpen] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null); // null = 새 기록
  const [seed, setSeed] = useState<Reassessment | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  // 최신 카드(idx=0)는 기본 펼침; toggledIdxs에 있으면 반전(XOR)
  const [toggledIdxs, setToggledIdxs] = useState<Set<number>>(new Set());
  const [goalBusy, setGoalBusy] = useState<number | null>(null);
  const [topFileBusy, setTopFileBusy] = useState(false);
  const [intakeFileBusy, setIntakeFileBusy] = useState(false);
  const runAnalyze = useServerFn(analyzeReassessment);
  const runExtractPlan = useServerFn(extractCarePlan);
  const [planBusy, setPlanBusy] = useState<number | null>(null);
  const [aiBusy, setAiBusy] = useState<number | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiTarget, setAiTarget] = useState<number | null>(null);
  const [aiDraft, setAiDraft] = useState<ReassessAiAnalysis | null>(null);
  const [aiMeta, setAiMeta] = useState<ReassessMeta | null>(null); // 이번 분석에서 추출한 실시일·척도

  // 기록 텍스트로 AI 분석 실행 (없으면 분석, 있으면 기존 추천안 편집)
  async function analyzeOrEdit(i: number) {
    if (all[i]?.aiAnalysis) {
      setAiTarget(i);
      setAiDraft(all[i].aiAnalysis!);
      setAiMeta(null);
      setAiOpen(true);
      return;
    }
    if (isAiBlocked(client)) {
      toast.error(AI_REFUSED_MESSAGE);
      return;
    }
    setAiBusy(i);
    try {
      let text = reassessToText(all[i]);
      // 작성 내용이 부족하면 첨부된 PDF에서 텍스트를 가져와 분석
      if (text.trim().length < 20) {
        const pdf = (all[i].files ?? []).find(
          (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name),
        );
        if (pdf) {
          text = await fetchPdfText(pdf).catch(() => "");
        }
      }
      if (text.trim().length < 20) {
        toast.error(
          "분석할 내용이 부족합니다. PDF가 스캔 이미지면 글자가 없어요 — 내용을 직접 입력하거나 텍스트 PDF를 올려주세요.",
        );
        return;
      }
      const r = await runAnalyze({ data: { text, clientId: client.id } });
      setAiTarget(i);
      setAiDraft({ ...r, at: new Date().toISOString(), confirmed: false });
      setAiMeta(r.meta ?? null);
      setAiOpen(true);
    } catch (e) {
      toast.error(aiErrorMessage((e as Error).message || ""));
    } finally {
      setAiBusy(null);
    }
  }

  // 기존 기록에서 계획서 추출 (Drive 텍스트 파일 또는 구버전 extractedText 사용)
  // forceDocType: 기존 기록에서 docType 미설정 시 수동으로 지정 가능
  async function extractPlanForRecord(i: number, forceDocType?: "intake" | "reassessment") {
    if (isAiBlocked(client)) {
      toast.error(AI_REFUSED_MESSAGE);
      return;
    }
    const r = all[i];
    const pdf = (r.files ?? []).find(
      (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name),
    );
    if (!pdf) {
      toast.error("이 기록에 PDF 파일이 없어요.");
      return;
    }
    const text = await fetchPdfText(pdf).catch(() => "");
    if (!text || text.trim().length < 20) {
      toast.error("PDF 텍스트를 가져오지 못했어요. 파일을 다시 업로드하면 계획서가 추출됩니다.");
      return;
    }
    setPlanBusy(i);
    const docType = forceDocType ?? (r.docType === "intake" ? "intake" : "reassessment");
    // docType이 forceDocType으로 강제된 경우 기록에도 저장
    const needsDocTypeUpdate = forceDocType && r.docType !== forceDocType;
    try {
      const result = await runExtractPlan({ data: { text, docType, clientId: client.id } });
      if (!result.ok || !result.year || !result.rows?.length) {
        toast.error(result.error ?? "계획서를 찾지 못했습니다.");
        return;
      }
      const ts = Date.now();
      const carePlan: CarePlan = {
        year: Number(result.year),
        rows: result.rows.map((row, ri) => ({
          id: `row-${ts}-${ri}`,
          priority: row.priority || ri + 1,
          problem: row.problem,
          need: row.need,
          selfPlan: (row.selfPlan ?? []).map((a, j) => ({
            id: `a-${ts}-${ri}-s${j}`,
            text: a.text,
            ...(a.targetCount ? { targetCount: a.targetCount } : {}),
            ...(a.unit ? { unit: a.unit } : {}),
          })),
          workerPlan: (row.workerPlan ?? []).map((a, j) => ({
            id: `a-${ts}-${ri}-w${j}`,
            text: a.text,
            ...(a.targetCount ? { targetCount: a.targetCount } : {}),
            ...(a.unit ? { unit: a.unit } : {}),
          })),
        })),
        extractedAt: new Date().toISOString(),
      };
      const updated = {
        ...r,
        carePlan,
        ...(needsDocTypeUpdate ? { docType: forceDocType } : {}),
      };
      const next = all.map((rec, idx) => (idx === i ? updated : rec));
      if (await persist(next)) {
        const label = docType === "intake" ? "적격심사지" : "재사정 기록지";
        toast.success(`${result.year}년 계획서 추출 완료 (${label} · ${result.rows.length}개 항목)`);
      }
    } catch (e) {
      toast.error("계획서 추출 실패: " + (e as Error).message);
    } finally {
      setPlanBusy(null);
    }
  }

  // AI 추천안 확정 저장
  async function saveAi(draft: ReassessAiAnalysis) {
    if (aiTarget === null) return;
    const next = [...all];
    const cur = next[aiTarget];
    const merged: Reassessment = {
      ...cur,
      aiAnalysis: { ...draft, confirmed: true, at: new Date().toISOString() },
    };
    // 문서에서 추출한 실시일·척도 등 반영: 비어있거나 업로드일(가짜값)이면 문서 기준으로 교체
    const m = aiMeta;
    if (m) {
      const dateIsFallback = !cur.reassessedAt || cur.reassessedAt === cur.uploadedAt;
      if (dateIsFallback && isYmd(m.reassessedAt)) merged.reassessedAt = m.reassessedAt;
      if (!cur.yearNo && m.yearNo) merged.yearNo = m.yearNo;
      if (!cur.method && m.method) merged.method = m.method;
      if (!cur.worker && m.worker) merged.worker = m.worker;
      if (!cur.result && m.result) merged.result = m.result;
      const sc = scalesFromMeta(m);
      if (sc) merged.scales = { ...sc, ...cur.scales }; // 기존 수기 입력값 우선
    }
    next[aiTarget] = merged;
    if (await persist(next)) {
      toast.success("AI 추천안이 저장되었습니다.");
      setAiOpen(false);
    }
  }

  // 서비스 목표 연계 (공용 GoalReflectDialog 사용)
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkNeeds, setLinkNeeds] = useState<ReassessNeed[]>([]);
  function openGoalLink(i: number) {
    const needs = all[i]?.aiAnalysis?.needs ?? [];
    if (needs.length === 0) return toast.error("먼저 [AI 추천안]에서 욕구를 확인·확정해주세요.");
    setLinkNeeds(needs);
    setLinkOpen(true);
  }

  // 최신순 정렬 + 기간 필터 (원본 인덱스 유지)
  const filtered = all
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.reassessedAt ?? "").localeCompare(a.r.reassessedAt ?? ""))
    .filter(({ r }) => {
      const d = r.reassessedAt ?? "";
      if (!fromDate && !toDate) return true;
      if (!d) return false;
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    });

  async function persist(next: Reassessment[]) {
    const cur = splitNote(client.note);
    const { error } = await supabase
      .from("clients")
      .update({ note: joinNote(cur.note, next, cur.goalAnalysis, cur.closeReason, cur.sideDishAssessments, cur.mealOpinion, cur.familyMembers) })
      .eq("id", client.id);
    if (error) {
      toast.error(error.message);
      return false;
    }
    onChanged();
    return true;
  }

  async function saveRecord(rec: Reassessment) {
    const next = [...all];
    if (editIndex === null) next.push(rec);
    else next[editIndex] = rec;
    if (await persist(next)) {
      toast.success("재사정 기록이 저장되었습니다.");
      setOpen(false);
    }
  }

  async function deleteRecord(i: number) {
    if (!confirm("이 재사정 기록을 삭제할까요?")) return;
    if (await persist(all.filter((_, j) => j !== i))) toast.success("삭제되었습니다.");
  }

  async function makeGoals(i: number) {
    const plan = all[i]?.plan ?? [];
    if (plan.length === 0) return toast.error("계획서 내용이 없습니다.");
    if (!confirm(`계획서 ${plan.length}개 항목으로 사례관리 목표를 생성할까요?`)) return;
    setGoalBusy(i);
    const rows = plan.map((p) => ({
      org_id: client.org_id,
      client_id: client.id,
      kind: "단기",
      title: p.need || p.action || "목표",
      detail: [p.problem, p.action].filter(Boolean).join(" / ") || null,
      progress: 0,
      source: "재사정 계획",
    }));
    const { error } = await supabase.from("goals").insert(rows);
    setGoalBusy(null);
    if (error) return toast.error(error.message);
    toast.success(`${rows.length}개 목표가 생성되었습니다.`);
    onChanged();
  }

  // Drive에서 PDF 텍스트를 가져오는 헬퍼
  // 우선순위: ① 구버전 DB 저장 텍스트 → ② Drive .txt 파일 → ③ 구버전 Supabase Storage
  async function fetchPdfText(pdf: { extractedText?: string; extractedTextDriveId?: string; path?: string }): Promise<string> {
    // ① 구버전: DB에 텍스트 직접 저장된 경우 (이전 업로드 호환)
    if (pdf.extractedText && pdf.extractedText.trim().length >= 20) {
      return pdf.extractedText;
    }
    // ② 신규: Drive .txt 파일에서 fetch (drive-proxy 경유)
    if (pdf.extractedTextDriveId) {
      const { data, error: fnErr } = await supabase.functions.invoke("drive-proxy", {
        body: { action: "getFileText", fileId: pdf.extractedTextDriveId },
      });
      if (fnErr) throw new Error("Drive 텍스트 읽기 실패: " + fnErr.message);
      const result = data as { text?: string; error?: string };
      if (result.error) throw new Error("Drive 텍스트 읽기 실패: " + result.error);
      return result.text ?? "";
    }
    // ③ 구버전 Supabase Storage PDF
    if (pdf.path) {
      return extractStoredPdfText(pdf.path).catch(() => "");
    }
    return "";
  }

  // Google Drive 파일 업로드 (Content-Type: text/plain → CORS preflight 없이 simple 요청)
  async function uploadToDrive(files: FileList, folderName = "재사정") {
    const added: { name: string; driveUrl: string; driveId: string; type?: string; extractedTextDriveId?: string; _inMemoryText?: string }[] = [];
    for (const file of Array.from(files)) {
      if (file.size > 20 * 1024 * 1024) {
        toast.error(`${file.name}: 20MB 이하만 업로드할 수 있어요.`);
        continue;
      }
      try {
        // 파일 → base64
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const CHUNK = 8192;
        const parts: string[] = [];
        for (let i = 0; i < bytes.byteLength; i += CHUNK) {
          parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
        }
        const base64 = btoa(parts.join(""));

        // PDF면 텍스트 추출 (메모리에만 유지 — DB에 저장 안 함)
        let inMemoryText: string | undefined;
        if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
          try { inMemoryText = await extractPdfText(file); } catch { /* 스캔 PDF 등 */ }
        }

        // ① PDF 원본 Drive 업로드 (drive-proxy 경유)
        const { data: uploadResp, error: fnErr } = await supabase.functions.invoke("drive-proxy", {
          body: { name: file.name, mimeType: file.type || "application/octet-stream", data: base64, folderName },
        });
        if (fnErr) throw new Error(fnErr.message);
        const data = uploadResp as { id?: string; url?: string; error?: string };
        if (data.error) throw new Error(data.error);
        if (!data.id || !data.url) throw new Error("Drive 업로드 실패: 응답 누락");

        // ② 텍스트가 있으면 Drive에 .txt 파일로 별도 업로드 (DB 저장 안 함)
        let extractedTextDriveId: string | undefined;
        if (inMemoryText && inMemoryText.trim().length >= 20) {
          try {
            // 한글 UTF-8 → base64
            const textBase64 = btoa(unescape(encodeURIComponent(inMemoryText)));
            const { data: txtResp } = await supabase.functions.invoke("drive-proxy", {
              body: {
                name: file.name.replace(/\.pdf$/i, "") + "_text.txt",
                mimeType: "text/plain",
                data: textBase64,
                folderName,
              },
            });
            const txtData = txtResp as { id?: string; error?: string } | null;
            if (txtData && !txtData.error) extractedTextDriveId = txtData.id;
          } catch {
            // 텍스트 .txt 업로드 실패해도 PDF 업로드는 성공으로 처리
          }
        }

        added.push({
          name: file.name,
          driveUrl: data.url,
          driveId: data.id,
          type: file.type,
          extractedTextDriveId,          // Drive .txt 파일 ID (DB에는 이것만 저장)
          _inMemoryText: inMemoryText,   // 현재 세션에서 바로 AI 분석용 (저장 안 함)
        });
      } catch (e) {
        toast.error(`${file.name} 업로드 실패: ${(e as Error).message}`);
      }
    }
    return added;
  }

  // 신규 재사정: 파일 업로드 → (PDF면) 텍스트 추출 → AI 분석까지 한 번에
  async function uploadNew(files: FileList) {
    setTopFileBusy(true);
    const tid = toast.loading("파일 업로드 중...");
    try {
      // Drive 업로드 시도 (실패해도 재사정 기록은 생성)
      const added = await uploadToDrive(files);
      // DB에 저장할 fileList: extractedText·_inMemoryText 제거 (DB 저장 안 함)
      const fileList = (added?.length
        ? added
        : Array.from(files).map((f) => ({ name: f.name, driveUrl: "", driveId: "", type: f.type }))
      ).map((f) => { const { _inMemoryText: _t, ...rest } = f as { _inMemoryText?: string; name: string; driveUrl: string; driveId: string; type?: string; extractedTextDriveId?: string }; return rest; }); // _inMemoryText는 저장하지 않음

      let aiAnalysis: ReassessAiAnalysis | undefined;
      let meta: ReassessMeta | undefined;
      let note = "";
      let carePlan: CarePlan | undefined;

      // PDF 텍스트: uploadToDrive에서 이미 추출한 인메모리 텍스트 재활용
      const addedPdf = added.find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
      const text = addedPdf?._inMemoryText ?? "";

      if (isAiBlocked(client)) {
        note = " (AI 활용을 거부한 대상자라 AI 분석은 생략했습니다)";
      } else if (text.trim().length >= 20) {
        toast.loading("AI 분석 중...", { id: tid });
        try {
          // 재사정 분석 + 계획서 추출 병렬 실행
          const [r, planResult] = await Promise.all([
            runAnalyze({ data: { text, clientId: client.id } }),
            runExtractPlan({ data: { text, clientId: client.id } }).catch(() => null),
          ]);
          aiAnalysis = { ...r, at: new Date().toISOString(), confirmed: false };
          meta = r.meta;
          if (planResult?.ok && planResult.year && planResult.rows?.length) {
            const ts = Date.now();
            carePlan = {
              year: planResult.year,
              rows: planResult.rows.map((row, i) => ({
                id: `row-${ts}-${i}`,
                priority: row.priority || i + 1,
                problem: row.problem,
                need: row.need,
                selfPlan: (row.selfPlan ?? []).map((a, j) => ({
                  id: `a-${ts}-${i}-s${j}`,
                  text: a.text,
                  ...(a.targetCount ? { targetCount: a.targetCount } : {}),
                  ...(a.unit ? { unit: a.unit } : {}),
                })),
                workerPlan: (row.workerPlan ?? []).map((a, j) => ({
                  id: `a-${ts}-${i}-w${j}`,
                  text: a.text,
                  ...(a.targetCount ? { targetCount: a.targetCount } : {}),
                  ...(a.unit ? { unit: a.unit } : {}),
                })),
              })),
              extractedAt: new Date().toISOString(),
            };
          }
        } catch (e) {
          note = " ⚠️ " + aiErrorMessage((e as Error).message || "") + " (기록의 [AI 분석]으로 재시도)";
        }
      } else if (added.some((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name))) {
        // PDF 업로드는 됐지만 텍스트 추출 실패 (스캔 이미지 등)
        note = " ⚠️ PDF에서 글자를 읽지 못했어요(스캔 이미지일 수 있어요). 기록의 [AI 분석]으로 다시 시도하거나 내용을 직접 입력하세요.";
      }
      // 기준일: 문서에서 실시일을 찾으면 그 날짜, 못 찾으면 업로드일로 폴백
      const today = new Date().toISOString().slice(0, 10);
      const scales = scalesFromMeta(meta);
      const rec: Reassessment = {
        reassessedAt: isYmd(meta?.reassessedAt) ? meta!.reassessedAt : today,
        uploadedAt: today,
        ...(meta?.yearNo ? { yearNo: meta.yearNo } : {}),
        ...(meta?.method ? { method: meta.method } : {}),
        ...(meta?.worker ? { worker: meta.worker } : {}),
        ...(meta?.result ? { result: meta.result } : {}),
        ...(scales ? { scales } : {}),
        files: fileList,
        ...(aiAnalysis ? { aiAnalysis } : {}),
        ...(carePlan ? { carePlan } : {}),
      };
      // 문서에서 실시일을 못 찾았고 AI 분석은 됐다면 안내 추가
      if (aiAnalysis && !isYmd(meta?.reassessedAt))
        note += " (문서에서 재사정 실시일을 못 찾아 업로드일로 표시했어요 — [수정]에서 실제 일시를 넣어주세요.)";
      if (await persist([...all, rec])) {
        toast.success(
          (aiAnalysis
            ? "파일 업로드 + AI 분석 완료. 기록의 [AI 추천안]에서 확인·수정하세요."
            : `파일 ${fileList.length}개 업로드됨.`) + note,
          { id: tid },
        );
      } else {
        toast.dismiss(tid);
      }
    } catch (e) {
      toast.error("업로드 실패: " + (e as Error).message, { id: tid });
    } finally {
      setTopFileBusy(false);
    }
  }

  // 적격심사지 업로드 — 신규 대상자용. 재사정과 동일한 흐름이지만 docType: "intake" 표시
  async function uploadIntake(files: FileList) {
    setIntakeFileBusy(true);
    const tid = toast.loading("적격심사지 업로드 중...");
    try {
      const added = await uploadToDrive(files, "적격심사지");
      const fileList = (added?.length
        ? added
        : Array.from(files).map((f) => ({ name: f.name, driveUrl: "", driveId: "", type: f.type }))
      ).map((f) => { const { _inMemoryText: _t, ...rest } = f as { _inMemoryText?: string; name: string; driveUrl: string; driveId: string; type?: string; extractedTextDriveId?: string }; return rest; });

      let aiAnalysis: ReassessAiAnalysis | undefined;
      let meta: ReassessMeta | undefined;
      let note = "";
      let carePlan: CarePlan | undefined;

      const addedPdf = added.find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
      const text = addedPdf?._inMemoryText ?? "";

      if (isAiBlocked(client)) {
        note = " (AI 활용을 거부한 대상자라 AI 분석은 생략했습니다)";
      } else if (text.trim().length >= 20) {
        toast.loading("AI 분석 중...", { id: tid });
        try {
          const [r, planResult] = await Promise.all([
            runAnalyze({ data: { text, clientId: client.id } }),
            runExtractPlan({ data: { text, docType: "intake", clientId: client.id } }).catch(() => null),
          ]);
          aiAnalysis = { ...r, at: new Date().toISOString(), confirmed: false };
          meta = r.meta;
          if (planResult?.ok && planResult.year && planResult.rows?.length) {
            const ts = Date.now();
            carePlan = {
              year: planResult.year,
              rows: planResult.rows.map((row, i) => ({
                id: `row-${ts}-${i}`,
                priority: row.priority || i + 1,
                problem: row.problem,
                need: row.need,
                selfPlan: (row.selfPlan ?? []).map((a, j) => ({
                  id: `a-${ts}-${i}-s${j}`,
                  text: a.text,
                  ...(a.targetCount ? { targetCount: a.targetCount } : {}),
                  ...(a.unit ? { unit: a.unit } : {}),
                })),
                workerPlan: (row.workerPlan ?? []).map((a, j) => ({
                  id: `a-${ts}-${i}-w${j}`,
                  text: a.text,
                  ...(a.targetCount ? { targetCount: a.targetCount } : {}),
                  ...(a.unit ? { unit: a.unit } : {}),
                })),
              })),
              extractedAt: new Date().toISOString(),
            };
          }
        } catch (e) {
          note = " ⚠️ " + aiErrorMessage((e as Error).message || "");
        }
      } else if (added.some((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name))) {
        note = " ⚠️ PDF에서 글자를 읽지 못했어요(스캔 이미지일 수 있어요). [계획서 추출] 버튼으로 다시 시도하세요.";
      }

      const today = new Date().toISOString().slice(0, 10);
      const scales = scalesFromMeta(meta);
      const rec: Reassessment = {
        docType: "intake",
        reassessedAt: isYmd(meta?.reassessedAt) ? meta!.reassessedAt : today,
        uploadedAt: today,
        ...(meta?.method ? { method: meta.method } : {}),
        ...(meta?.worker ? { worker: meta.worker } : {}),
        ...(scales ? { scales } : {}),
        files: fileList,
        ...(aiAnalysis ? { aiAnalysis } : {}),
        ...(carePlan ? { carePlan } : {}),
      };
      if (await persist([...all, rec])) {
        toast.success(
          (carePlan
            ? `적격심사지 업로드 완료. 계획서 ${carePlan.rows.length}개 항목 추출됨.`
            : aiAnalysis
              ? "적격심사지 업로드 + AI 분석 완료. [계획서 추출]로 사례관리 계획을 생성하세요."
              : `적격심사지 ${fileList.length}개 업로드됨.`) + note,
          { id: tid },
        );
      } else {
        toast.dismiss(tid);
      }
    } catch (e) {
      toast.error("업로드 실패: " + (e as Error).message, { id: tid });
    } finally {
      setIntakeFileBusy(false);
    }
  }

  function openStoredFile(f: { path?: string; driveUrl?: string; name?: string }) {
    // Drive URL 우선, 없으면 구버전 Storage signed URL
    if (f.driveUrl) {
      openDriveFile(f.driveUrl, f.name || "재사정 첨부 파일", { kind: "재사정 첨부", client });
    } else if (f.path) {
      supabase.storage.from(BUCKET).createSignedUrl(f.path, 120).then(({ data, error }) => {
        if (error || !data) return toast.error("파일을 열 수 없어요: " + (error?.message ?? ""));
        window.open(data.signedUrl, "_blank");
      });
    }
  }

  async function removeFile(recIndex: number, fileIndex: number) {
    const f = all[recIndex]?.files?.[fileIndex];
    if (!f) return;
    if (!confirm("첨부 파일을 삭제할까요?")) return;
    // 구버전 Storage 파일이면 제거 시도 (실패해도 진행)
    if (f.path) await supabase.storage.from(BUCKET).remove([f.path]).catch(() => null);
    const next = [...all];
    next[recIndex] = {
      ...all[recIndex],
      files: (all[recIndex].files ?? []).filter((_, j) => j !== fileIndex),
    };
    await persist(next);
  }

  return (
    <div className="space-y-3">
      {/* 상단: 기간 필터 + 액션 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-muted-foreground">기간</span>
          <Input
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-8 w-[8.5rem]"
            aria-label="시작일"
          />
          <span className="text-muted-foreground">~</span>
          <Input
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setToDate(e.target.value)}
            className="h-8 w-[8.5rem]"
            aria-label="종료일"
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
        <div className="flex items-center gap-1 flex-wrap">
          {/* 적격심사지 업로드 (신규 대상자용) */}
          <label className="text-sm inline-flex items-center gap-1 cursor-pointer rounded-md border border-border px-3 h-9 hover:bg-accent">
            {intakeFileBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileText className="h-4 w-4" />
            )}
            적격심사지 업로드
            <input
              type="file"
              multiple
              accept="image/*,application/pdf,.pdf,.doc,.docx"
              className="hidden"
              disabled={intakeFileBusy || topFileBusy}
              onChange={(e) => {
                if (e.target.files?.length) uploadIntake(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          {/* 재사정 파일 업로드 */}
          <label className="text-sm inline-flex items-center gap-1 cursor-pointer rounded-md border border-border px-3 h-9 hover:bg-accent">
            {topFileBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            재사정 업로드
            <input
              type="file"
              multiple
              accept="image/*,application/pdf,.pdf,.doc,.docx"
              className="hidden"
              disabled={topFileBusy || intakeFileBusy}
              onChange={(e) => {
                if (e.target.files?.length) uploadNew(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <Button
            size="sm"
            onClick={() => {
              setEditIndex(null);
              setSeed(null);
              setOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            재사정 추가
          </Button>
        </div>
      </div>

      {all.length >= 2 && <ReassessTrend all={all} />}

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          <ClipboardCheck className="h-7 w-7 mx-auto mb-2 opacity-40" />
          {all.length === 0
            ? "등록된 재사정 기록이 없습니다. [재사정 추가] 또는 [파일 업로드]로 시작하세요."
            : "선택한 기간에 재사정 기록이 없습니다."}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(({ r, i }, idx) => {
            const isExpanded = (idx === 0) !== toggledIdxs.has(i);
            return (
            <div key={i} className="rounded-lg border border-border">
              <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border flex-wrap">
                <div
                  className="flex items-center gap-1.5 flex-wrap text-sm cursor-pointer select-none"
                  onClick={() => setToggledIdxs((prev) => {
                    const next = new Set(prev);
                    next.has(i) ? next.delete(i) : next.add(i);
                    return next;
                  })}
                >
                  <ChevronDown className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform ${isExpanded ? "" : "-rotate-90"}`} />
                  <span className="font-medium">{r.reassessedAt || "일시 미상"}</span>
                  {r.uploadedAt && r.uploadedAt !== r.reassessedAt && (
                    <span className="text-[11px] text-muted-foreground font-normal">
                      업로드 {r.uploadedAt}
                    </span>
                  )}
                  {r.docType === "intake" ? (
                    <Badge variant="outline" className="border-blue-500 text-blue-600">
                      적격심사지
                    </Badge>
                  ) : (
                    r.yearNo && <Badge variant="outline">{r.yearNo}년차</Badge>
                  )}
                  {r.result && (
                    <Badge variant="outline" className="border-primary text-primary">
                      {r.result}
                    </Badge>
                  )}
                  {r.carePlan && (
                    <Badge variant="outline" className="border-emerald-500 text-emerald-600 text-[10px]">
                      계획서 {r.carePlan.year}년 연동됨
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {r.plan && r.plan.length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      onClick={() => makeGoals(i)}
                      disabled={goalBusy === i}
                    >
                      {goalBusy === i ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Target className="h-4 w-4" />
                      )}
                      목표 만들기
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    onClick={() => analyzeOrEdit(i)}
                    disabled={aiBusy === i}
                  >
                    {aiBusy === i ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                    {r.aiAnalysis ? "AI 추천안" : "AI 분석"}
                  </Button>
                  <AiModelBadge />
                  {/* 계획서 추출 버튼: docType 없는 기존 기록은 드롭다운으로 방식 선택 */}
                  {!r.docType ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-0.5"
                          disabled={planBusy === i}
                          title={r.carePlan ? `${r.carePlan.year}년 계획서 추출됨 (재추출)` : "문서 종류를 선택해 계획서 추출"}
                        >
                          {planBusy === i ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Target className="h-4 w-4" />
                          )}
                          {r.carePlan ? "계획서 재추출" : "계획서 추출"}
                          <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => extractPlanForRecord(i, "reassessment")}>
                          <Target className="h-4 w-4 mr-2" />
                          재사정 기록지로 추출
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => extractPlanForRecord(i, "intake")}>
                          <Target className="h-4 w-4 mr-2 text-blue-500" />
                          <span className="text-blue-600">적격심사지로 추출</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      onClick={() => extractPlanForRecord(i)}
                      disabled={planBusy === i}
                      title={r.carePlan ? `${r.carePlan.year}년 계획서 추출됨 (재추출)` : "계획서 추출"}
                    >
                      {planBusy === i ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Target className="h-4 w-4" />
                      )}
                      {r.carePlan ? "계획서 재추출" : "계획서 추출"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    onClick={() => {
                      setEditIndex(i);
                      setSeed(r);
                      setOpen(true);
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                    수정
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-destructive"
                    onClick={() => deleteRecord(i)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {isExpanded && <div className="p-3 space-y-3">
                <ReassessmentView r={r} />

                {/* 첨부 자료 */}
                <div className="rounded-md border border-border p-2.5">
                  <div className="mb-1.5">
                    <span className="text-xs font-semibold text-primary">
                      첨부 자료 (이미지·PDF 등)
                    </span>
                  </div>
                  {(r.files?.length ?? 0) === 0 ? (
                    <p className="text-xs text-muted-foreground">첨부된 파일이 없습니다.</p>
                  ) : (
                    <ul className="space-y-1">
                      {r.files!.map((f, fi) => (
                        <li key={fi} className="flex items-center justify-between gap-2 text-xs">
                          <button
                            type="button"
                            onClick={() => openStoredFile(f)}
                            className="inline-flex items-center gap-1 underline hover:text-foreground truncate"
                          >
                            <FileText className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{f.name}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => removeFile(i, fi)}
                            className="text-muted-foreground hover:text-destructive shrink-0"
                            aria-label="첨부 삭제"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>}
            </div>
            );
          })}
        </div>
      )}

      <ReassessmentDialog
        open={open}
        onOpenChange={setOpen}
        clientName={client.name}
        initial={seed}
        onSave={saveRecord}
      />
      <AiAnalysisDialog open={aiOpen} onOpenChange={setAiOpen} draft={aiDraft} onSave={saveAi} />
      <GoalReflectDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        needs={linkNeeds}
        client={client}
        onDone={onChanged}
      />
    </div>
  );
}

const AI_SECTIONS: { key: keyof ReassessAiAnalysis; label: string }[] = [
  { key: "physicalChanges", label: "신체적 상황 변화" },
  { key: "psychologicalChanges", label: "심리·정서적 상황 변화" },
  { key: "economicChanges", label: "경제적 상황 변화" },
  { key: "socialChanges", label: "사회적 관계망 변화" },
  { key: "etcChanges", label: "기타 변화사항" },
  { key: "areaChanges", label: "영역별 주요 변화 요약 (구버전)" },
  { key: "expressedNeeds", label: "당사자가 표현한 요구" },
  { key: "identifiedNeeds", label: "실제로 확인되는 욕구" },
  { key: "problems", label: "주요 문제" },
  { key: "risks", label: "위험요인 및 긴급성" },
  { key: "strengths", label: "강점 및 활용 가능한 자원" },
  { key: "interventionAreas", label: "서비스 개입이 필요한 영역" },
  { key: "recommendedGoals", label: "추천 욕구 목표" },
  { key: "recommendedActions", label: "추천 행동계획" },
  { key: "priorities", label: "서비스 우선순위" },
];

// 우선순위·긴급성 뱃지 색
function levelTone(v: string): string {
  if (/상|높음|긴급/.test(v)) return "border-red-400 text-red-600 bg-red-50";
  if (/중|보통/.test(v)) return "border-amber-400 text-amber-700 bg-amber-50";
  if (/하|낮음/.test(v)) return "border-border text-muted-foreground";
  return "border-border text-muted-foreground";
}

// 상세 서술 섹션(위험·우선순위 제외 8개) — 접었다 펼 수 있게
const DETAIL_SECTIONS = AI_SECTIONS.filter((s) => s.key !== "risks" && s.key !== "priorities");

/** AI 추천안을 위험/우선순위/욕구표/상세로 나눠 스캔하기 쉽게 보여준다. */
function AiAnalysisCard({ a }: { a: ReassessAiAnalysis }) {
  const needs = a.needs ?? [];
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
        <Sparkles className="h-3.5 w-3.5" /> AI 추천안{" "}
        {a.confirmed ? "(확정)" : "(미확정 — [AI 추천안]에서 확인하세요)"}
      </div>

      {/* 위험요인·긴급성 — 눈에 띄게 */}
      {a.risks?.trim() && (
        <div className="rounded-md border border-red-300 bg-red-50 p-2.5">
          <div className="flex items-center gap-1 text-xs font-semibold text-red-700 mb-0.5">
            <AlertTriangle className="h-3.5 w-3.5" /> 위험요인 · 긴급성
          </div>
          <p className="text-sm text-red-900 whitespace-pre-wrap leading-relaxed">{a.risks}</p>
        </div>
      )}

      {/* 서비스 우선순위 */}
      {a.priorities?.trim() && (
        <div className="rounded-md border border-primary/30 bg-background p-2.5">
          <div className="text-xs font-semibold text-primary mb-0.5">서비스 우선순위</div>
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{a.priorities}</p>
        </div>
      )}

      {/* 욕구별 항목 — 가장 실행적인 표 */}
      {needs.length > 0 && (
        <div className="rounded-md border border-border bg-background p-2.5">
          <div className="flex items-center gap-1 text-xs font-semibold text-primary mb-1.5">
            <ListChecks className="h-3.5 w-3.5" /> 욕구별 목표 ({needs.length}건)
          </div>
          <div className="space-y-2">
            {needs.map((n, i) => (
              <div key={i} className="rounded border border-border p-2 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium">
                    {n.need || n.problem || `욕구 ${i + 1}`}
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    {n.priority && (
                      <Badge
                        variant="outline"
                        className={`text-[10px] px-1.5 py-0 ${levelTone(n.priority)}`}
                      >
                        우선 {n.priority}
                      </Badge>
                    )}
                    {n.urgency && (
                      <Badge
                        variant="outline"
                        className={`text-[10px] px-1.5 py-0 ${levelTone(n.urgency)}`}
                      >
                        긴급 {n.urgency}
                      </Badge>
                    )}
                  </span>
                </div>
                {n.goal && (
                  <div className="text-xs">
                    <span className="text-muted-foreground">목표 </span>
                    {n.goal}
                  </div>
                )}
                {(n.clientAction || n.workerAction) && (
                  <div className="text-xs text-muted-foreground">
                    {n.clientAction && <div>· 당사자: {n.clientAction}</div>}
                    {n.workerAction && <div>· 담당자: {n.workerAction}</div>}
                  </div>
                )}
                {(n.checkCycle || n.criteria) && (
                  <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-3">
                    {n.checkCycle && <span>점검: {n.checkCycle}</span>}
                    {n.criteria && <span>달성기준: {n.criteria}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 영역별 상세 서술 — 기본 접힘 */}
      {DETAIL_SECTIONS.some((s) => (a[s.key] as string | undefined)?.trim()) && (
        <details className="group rounded-md border border-border bg-background">
          <summary className="flex items-center gap-1 cursor-pointer px-2.5 py-2 text-xs font-medium text-muted-foreground list-none">
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
            영역별 상세 분석 펼쳐보기
          </summary>
          <div className="px-2.5 pb-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {DETAIL_SECTIONS.map((s) => {
              const v = a[s.key] as string | undefined;
              if (!v?.trim()) return null;
              return (
                <div key={s.key} className="rounded border border-border p-2">
                  <div className="text-[11px] font-semibold text-primary mb-0.5">{s.label}</div>
                  <p className="text-xs whitespace-pre-wrap leading-relaxed">{v}</p>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

function AiAnalysisDialog({
  open,
  onOpenChange,
  draft,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  draft: ReassessAiAnalysis | null;
  onSave: (d: ReassessAiAnalysis) => Promise<void>;
}) {
  const [f, setF] = useState<ReassessAiAnalysis>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setF(structuredClone(draft ?? {}));
  }, [open, draft]);
  const set = (k: keyof ReassessAiAnalysis, v: string) => setF((s) => ({ ...s, [k]: v }));
  const setNeed = (i: number, k: keyof ReassessNeed, v: string) =>
    setF((s) => {
      const arr = [...(s.needs ?? [])];
      arr[i] = { ...arr[i], [k]: v };
      return { ...s, needs: arr };
    });
  const addNeed = () =>
    setF((s) => ({
      ...s,
      needs: [
        ...(s.needs ?? []),
        { problem: "", need: "", goal: "", clientAction: "", workerAction: "", priority: "중", urgency: "보통", checkCycle: "", criteria: "" },
      ],
    }));
  const delNeed = (i: number) =>
    setF((s) => ({ ...s, needs: (s.needs ?? []).filter((_, j) => j !== i) }));

  async function save() {
    setSaving(true);
    await onSave(f);
    setSaving(false);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-primary" /> AI 추천안 (담당자 확인·수정)
            <AiModelBadge className="ml-1" />
          </DialogTitle>
          <DialogDescription>
            AI가 재사정 내용을 분석한 초안입니다. 확인·수정 후 [저장(확정)]하세요.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {AI_SECTIONS.map((s) => (
            <div key={s.key} className="space-y-1">
              <Label className="text-xs font-medium">{s.label}</Label>
              <Textarea
                rows={2}
                value={(f[s.key] as string) ?? ""}
                onChange={(e) => set(s.key, e.target.value)}
                className="text-sm"
              />
            </div>
          ))}

          {/* 욕구별 항목 편집 */}
          <div className="rounded-md border border-border p-2.5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-primary">
                욕구별 항목 (서비스 목표 연계용 · {f.needs?.length ?? 0}건)
              </div>
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={addNeed}>
                <Plus className="h-3 w-3 mr-1" />항목 추가
              </Button>
            </div>
            {(f.needs?.length ?? 0) === 0 && (
              <p className="text-xs text-muted-foreground text-center py-2">항목이 없습니다. [항목 추가]를 눌러 직접 작성하세요.</p>
            )}
            {(f.needs ?? []).map((n, i) => (
              <div key={i} className="rounded border border-border bg-muted/20 p-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-muted-foreground">{i + 1}번 항목</span>
                  <button type="button" onClick={() => delNeed(i)} className="text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-0.5">
                    <Label className="text-[11px]">문제</Label>
                    <Input value={n.problem} onChange={(e) => setNeed(i, "problem", e.target.value)} className="h-7 text-xs" />
                  </div>
                  <div className="space-y-0.5">
                    <Label className="text-[11px]">욕구</Label>
                    <Input value={n.need} onChange={(e) => setNeed(i, "need", e.target.value)} className="h-7 text-xs" />
                  </div>
                </div>
                <div className="space-y-0.5">
                  <Label className="text-[11px]">목표</Label>
                  <Textarea rows={2} value={n.goal} onChange={(e) => setNeed(i, "goal", e.target.value)} className="text-xs" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-0.5">
                    <Label className="text-[11px]">당사자 행동계획</Label>
                    <Textarea rows={2} value={n.clientAction} onChange={(e) => setNeed(i, "clientAction", e.target.value)} className="text-xs" />
                  </div>
                  <div className="space-y-0.5">
                    <Label className="text-[11px]">담당자 행동계획</Label>
                    <Textarea rows={2} value={n.workerAction} onChange={(e) => setNeed(i, "workerAction", e.target.value)} className="text-xs" />
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <div className="space-y-0.5">
                    <Label className="text-[11px]">우선순위</Label>
                    <Select value={n.priority} onValueChange={(v) => setNeed(i, "priority", v)}>
                      <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {["상", "중", "하"].map((v) => <SelectItem key={v} value={v} className="text-xs">{v}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-0.5">
                    <Label className="text-[11px]">긴급성</Label>
                    <Select value={n.urgency} onValueChange={(v) => setNeed(i, "urgency", v)}>
                      <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {["높음", "보통", "낮음"].map((v) => <SelectItem key={v} value={v} className="text-xs">{v}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-0.5">
                    <Label className="text-[11px]">점검주기</Label>
                    <Input value={n.checkCycle} onChange={(e) => setNeed(i, "checkCycle", e.target.value)} className="h-7 text-xs" placeholder="예: 월 1회" />
                  </div>
                  <div className="space-y-0.5">
                    <Label className="text-[11px]">달성기준</Label>
                    <Input value={n.criteria} onChange={(e) => setNeed(i, "criteria", e.target.value)} className="h-7 text-xs" />
                  </div>
                </div>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              ※ 이 항목들은 다음 단계 [서비스 목표에 반영]에서 사용됩니다.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} 저장(확정)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  if (!value?.trim()) return null;
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="whitespace-pre-wrap">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border p-3 space-y-1.5">
      <div className="text-xs font-semibold text-primary">{title}</div>
      {children}
    </div>
  );
}

/** 하나라도 값이 있으면 true — 빈 섹션(제목만) 숨김용. */
const hasText = (...vals: (string | undefined | null)[]) => vals.some((v) => v?.trim());

function ReassessmentView({ r }: { r: Reassessment }) {
  const p = r.personal ?? {};
  const c = r.changes ?? {};
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {r.reassessedAt && <Badge variant="outline">일시 {r.reassessedAt}</Badge>}
        {r.yearNo && <Badge variant="outline">{r.yearNo}년차</Badge>}
        {r.method && <Badge variant="outline">방법 {r.method}</Badge>}
        {r.worker && <Badge variant="outline">담당 {r.worker}</Badge>}
        {r.result && (
          <Badge variant="outline" className="border-primary text-primary">
            결과: {r.result}
          </Badge>
        )}
      </div>

      {r.aiAnalysis && <AiAnalysisCard a={r.aiAnalysis} />}

      {hasText(
        p.religion,
        p.protection,
        p.disability,
        p.education,
        p.household,
        p.longTermCare,
        p.emergencyContact,
        p.emergencyRelation,
      ) && (
        <Section title="인적사항">
          <Row label="종교" value={p.religion} />
          <Row label="보호구분" value={p.protection} />
          <Row label="장애" value={p.disability} />
          <Row label="교육정도" value={p.education} />
          <Row label="가족구성" value={p.household} />
          <Row label="장기요양" value={p.longTermCare} />
          <Row
            label="비상연락처"
            value={[p.emergencyContact, p.emergencyRelation].filter(Boolean).join(" · ")}
          />
        </Section>
      )}

      {r.family && r.family.length > 0 && (
        <Section title="가족사항">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b">
                <tr className="text-left">
                  <th className="py-1 pr-2">관계</th>
                  <th className="py-1 pr-2">성명</th>
                  <th className="py-1 pr-2">나이</th>
                  <th className="py-1 pr-2">직업</th>
                  <th className="py-1 pr-2">동거</th>
                  <th className="py-1">비고</th>
                </tr>
              </thead>
              <tbody>
                {r.family.map((f, i) => (
                  <tr key={i} className="border-b border-border last:border-0 align-top">
                    <td className="py-1 pr-2 whitespace-nowrap">{f.relation || "-"}</td>
                    <td className="py-1 pr-2 whitespace-nowrap">{f.name || "-"}</td>
                    <td className="py-1 pr-2 whitespace-nowrap">{f.age || "-"}</td>
                    <td className="py-1 pr-2">{f.job || "-"}</td>
                    <td className="py-1 pr-2 whitespace-nowrap">{f.cohabit || "-"}</td>
                    <td className="py-1">{f.note || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {hasText(r.reassessType, r.reassessFactor) && (
        <Section title="재사정 유형 · 요인">
          <Row label="유형" value={r.reassessType} />
          <Row label="요인" value={r.reassessFactor} />
        </Section>
      )}

      {hasText(c.physical, c.psychological, c.economic, c.social, c.etc) && (
        <Section title="당사자의 변화된 상황 및 욕구">
          <Row label="신체적" value={c.physical} />
          <Row label="심리적" value={c.psychological} />
          <Row label="경제적" value={c.economic} />
          <Row label="관계망" value={c.social} />
          <Row label="기타" value={c.etc} />
        </Section>
      )}

      {(r.scales?.sgdsTotal || r.scales?.mspssAgency || r.scales?.sgds || r.scales?.mspss) && (
        <Section title="척도">
          <Row
            label="우울(SGDS)"
            value={
              r.scales?.sgds ||
              [r.scales?.sgdsTotal && `${r.scales.sgdsTotal}점`, r.scales?.sgdsResult]
                .filter(Boolean)
                .join(" · ")
            }
          />
          <Row label="SGDS 의견" value={r.scales?.sgdsOpinion} />
          <Row
            label="사회지지(MSPSS)"
            value={
              r.scales?.mspss ||
              [
                r.scales?.mspssAgency && `복지관 ${r.scales.mspssAgency}`,
                r.scales?.mspssFriend && `친구 ${r.scales.mspssFriend}`,
                r.scales?.mspssOther && `주변인 ${r.scales.mspssOther}`,
              ]
                .filter(Boolean)
                .join(" · ")
            }
          />
          <Row label="MSPSS 의견" value={r.scales?.mspssOpinion} />
        </Section>
      )}

      {r.evaluation?.items && r.evaluation.items.length > 0 && (
        <Section title="사례관리 평가서">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b">
                <tr className="text-left">
                  <th className="py-1 pr-2">욕구</th>
                  <th className="py-1 pr-2">실행목표</th>
                  <th className="py-1 pr-2">실행 내용</th>
                  <th className="py-1">달성도</th>
                </tr>
              </thead>
              <tbody>
                {r.evaluation.items.map((it, i) => (
                  <tr key={i} className="border-b border-border last:border-0 align-top">
                    <td className="py-1 pr-2 whitespace-nowrap">{it.need}</td>
                    <td className="py-1 pr-2">{it.goal}</td>
                    <td className="py-1 pr-2">{it.content}</td>
                    <td className="py-1 whitespace-nowrap font-medium">{it.achievement}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Row label="총평(대상자)" value={r.evaluation.clientReview} />
          <Row label="총평(복지사)" value={r.evaluation.workerReview} />
          <Row label="평가 결과" value={r.evaluation.result} />
        </Section>
      )}

      {r.plan && r.plan.length > 0 && (
        <Section title="사례관리 계획서">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b">
                <tr className="text-left">
                  <th className="py-1 pr-2">문제</th>
                  <th className="py-1 pr-2">욕구</th>
                  <th className="py-1 pr-2">행동계획</th>
                  <th className="py-1">우선</th>
                </tr>
              </thead>
              <tbody>
                {r.plan.map((it, i) => (
                  <tr key={i} className="border-b border-border last:border-0 align-top">
                    <td className="py-1 pr-2">{it.problem}</td>
                    <td className="py-1 pr-2 whitespace-nowrap">{it.need}</td>
                    <td className="py-1 pr-2">{it.action}</td>
                    <td className="py-1 whitespace-nowrap">{it.priority}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {(r.contract?.period || r.contract?.services) && (
        <Section title="서비스 계약서">
          <Row label="제공 기간" value={r.contract?.period} />
          <Row label="서비스 종류" value={r.contract?.services} />
          <Row label="비고" value={r.contract?.note} />
        </Section>
      )}

      {r.workerOpinion && (
        <Section title="사회복지사 의견">
          <p className="text-sm whitespace-pre-wrap">{r.workerOpinion}</p>
        </Section>
      )}
    </div>
  );
}

function ReassessmentDialog({
  open,
  onOpenChange,
  clientName,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  clientName: string;
  initial: Reassessment | null;
  onSave: (rec: Reassessment) => Promise<void>;
}) {
  const [f, setF] = useState<Reassessment>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      const cloned = structuredClone(initial ?? {});
      // changes 필드가 전부 비어 있는데 AI 분석에 영역별 내용이 있으면 pre-populate
      const ai = cloned.aiAnalysis;
      const hasNoChanges =
        !cloned.changes?.physical &&
        !cloned.changes?.psychological &&
        !cloned.changes?.economic &&
        !cloned.changes?.social;
      if (hasNoChanges && ai) {
        // 신규 per-area 필드 우선, 구버전 areaChanges는 fallback으로 physical에
        const hasPerArea = ai.physicalChanges || ai.psychologicalChanges || ai.economicChanges || ai.socialChanges;
        cloned.changes = {
          ...cloned.changes,
          physical: ai.physicalChanges || (!hasPerArea ? ai.areaChanges : "") || "",
          psychological: ai.psychologicalChanges || "",
          economic: ai.economicChanges || "",
          social: ai.socialChanges || "",
          etc: ai.etcChanges || cloned.changes?.etc || "",
        };
      }
      setF(cloned);
    }
  }, [open, initial]);

  const p = f.personal ?? {};
  const c = f.changes ?? {};
  const family = f.family ?? [];

  const setP = (k: keyof NonNullable<Reassessment["personal"]>, v: string) =>
    setF((s) => ({ ...s, personal: { ...s.personal, [k]: v } }));
  const setC = (k: keyof NonNullable<Reassessment["changes"]>, v: string) =>
    setF((s) => ({ ...s, changes: { ...s.changes, [k]: v } }));
  const setFam = (i: number, k: keyof ReassessFamily, v: string) =>
    setF((s) => {
      const arr = [...(s.family ?? [])];
      arr[i] = { ...arr[i], [k]: v };
      return { ...s, family: arr };
    });
  const addFam = () =>
    setF((s) => ({
      ...s,
      family: [
        ...(s.family ?? []),
        { relation: "", name: "", age: "", job: "", cohabit: "비동거", note: "" },
      ],
    }));
  const delFam = (i: number) =>
    setF((s) => ({ ...s, family: (s.family ?? []).filter((_, j) => j !== i) }));

  async function save() {
    setSaving(true);
    await onSave(f);
    setSaving(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>재사정 기록</DialogTitle>
          <DialogDescription>
            {clientName} 어르신의 재사정 기록지 내용을 입력하세요.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Fld label="일시">
              <Input
                type="date"
                value={f.reassessedAt ?? ""}
                onChange={(e) => setF((s) => ({ ...s, reassessedAt: e.target.value }))}
              />
            </Fld>
            <Fld label="년차">
              <Input
                value={f.yearNo ?? ""}
                onChange={(e) => setF((s) => ({ ...s, yearNo: e.target.value }))}
              />
            </Fld>
            <Fld label="방법">
              <Sel
                value={f.method}
                onChange={(v) => setF((s) => ({ ...s, method: v }))}
                options={METHODS}
              />
            </Fld>
            <Fld label="담당자">
              <Input
                value={f.worker ?? ""}
                onChange={(e) => setF((s) => ({ ...s, worker: e.target.value }))}
              />
            </Fld>
          </div>

          <fieldset className="rounded-md border border-border p-3 space-y-2">
            <legend className="text-xs font-semibold px-1">인적사항</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Fld label="종교">
                <Input
                  value={p.religion ?? ""}
                  onChange={(e) => setP("religion", e.target.value)}
                />
              </Fld>
              <Fld label="보호구분">
                <Input
                  value={p.protection ?? ""}
                  onChange={(e) => setP("protection", e.target.value)}
                />
              </Fld>
              <Fld label="장애">
                <Input
                  value={p.disability ?? ""}
                  onChange={(e) => setP("disability", e.target.value)}
                />
              </Fld>
              <Fld label="교육정도">
                <Input
                  value={p.education ?? ""}
                  onChange={(e) => setP("education", e.target.value)}
                />
              </Fld>
              <Fld label="가족구성">
                <Input
                  value={p.household ?? ""}
                  onChange={(e) => setP("household", e.target.value)}
                />
              </Fld>
              <Fld label="장기요양">
                <Input
                  value={p.longTermCare ?? ""}
                  onChange={(e) => setP("longTermCare", e.target.value)}
                />
              </Fld>
              <Fld label="비상연락처">
                <Input
                  value={p.emergencyContact ?? ""}
                  onChange={(e) => setP("emergencyContact", e.target.value)}
                />
              </Fld>
              <Fld label="관계">
                <Input
                  value={p.emergencyRelation ?? ""}
                  onChange={(e) => setP("emergencyRelation", e.target.value)}
                />
              </Fld>
            </div>
          </fieldset>

          <fieldset className="rounded-md border border-border p-3 space-y-2">
            <legend className="text-xs font-semibold px-1">가족사항</legend>
            <div className="space-y-2">
              {family.map((fm, i) => (
                <div key={i} className="grid grid-cols-12 gap-1 items-center">
                  <Input
                    className="col-span-3 h-8"
                    placeholder="관계"
                    value={fm.relation}
                    onChange={(e) => setFam(i, "relation", e.target.value)}
                  />
                  <Input
                    className="col-span-2 h-8"
                    placeholder="성명"
                    value={fm.name}
                    onChange={(e) => setFam(i, "name", e.target.value)}
                  />
                  <Input
                    className="col-span-1 h-8"
                    placeholder="나이"
                    value={fm.age}
                    onChange={(e) => setFam(i, "age", e.target.value)}
                  />
                  <Input
                    className="col-span-2 h-8"
                    placeholder="직업"
                    value={fm.job}
                    onChange={(e) => setFam(i, "job", e.target.value)}
                  />
                  <Input
                    className="col-span-2 h-8"
                    placeholder="동거"
                    value={fm.cohabit}
                    onChange={(e) => setFam(i, "cohabit", e.target.value)}
                  />
                  <Input
                    className="col-span-1 h-8"
                    placeholder="비고"
                    value={fm.note}
                    onChange={(e) => setFam(i, "note", e.target.value)}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="col-span-1 h-8 w-8"
                    onClick={() => delFam(i)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" onClick={addFam}>
                <Plus className="h-4 w-4" />
                가족 추가
              </Button>
            </div>
          </fieldset>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Fld label="재사정 유형">
              <Sel
                value={f.reassessType}
                onChange={(v) => setF((s) => ({ ...s, reassessType: v }))}
                options={REASSESS_TYPES}
              />
            </Fld>
            <Fld label="재사정 요인">
              <Input
                value={f.reassessFactor ?? ""}
                onChange={(e) => setF((s) => ({ ...s, reassessFactor: e.target.value }))}
              />
            </Fld>
          </div>

          <fieldset className="rounded-md border border-border p-3 space-y-2">
            <legend className="text-xs font-semibold px-1">당사자의 변화된 상황 및 욕구</legend>
            {f.aiAnalysis && !initial?.changes?.physical && !initial?.changes?.psychological && (
              <p className="text-[11px] text-muted-foreground bg-muted/50 rounded px-2 py-1">
                💡 AI가 추출한 영역별 변화 내용을 자동 입력했습니다. 내용을 확인·수정하세요.
              </p>
            )}
            <Fld label="신체적 상황">
              <Textarea
                rows={3}
                value={c.physical ?? ""}
                onChange={(e) => setC("physical", e.target.value)}
              />
            </Fld>
            <Fld label="심리적 상황">
              <Textarea
                rows={2}
                value={c.psychological ?? ""}
                onChange={(e) => setC("psychological", e.target.value)}
              />
            </Fld>
            <Fld label="경제적 상황">
              <Textarea
                rows={3}
                value={c.economic ?? ""}
                onChange={(e) => setC("economic", e.target.value)}
              />
            </Fld>
            <Fld label="사회적 관계망">
              <Textarea
                rows={3}
                value={c.social ?? ""}
                onChange={(e) => setC("social", e.target.value)}
              />
            </Fld>
            <Fld label="기타">
              <Input value={c.etc ?? ""} onChange={(e) => setC("etc", e.target.value)} />
            </Fld>
          </fieldset>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Fld label="우울척도(SGDS)">
              <Input
                value={f.scales?.sgds ?? ""}
                onChange={(e) =>
                  setF((s) => ({ ...s, scales: { ...s.scales, sgds: e.target.value } }))
                }
              />
            </Fld>
            <Fld label="사회지지(MSPSS)">
              <Input
                value={f.scales?.mspss ?? ""}
                onChange={(e) =>
                  setF((s) => ({ ...s, scales: { ...s.scales, mspss: e.target.value } }))
                }
              />
            </Fld>
          </div>

          <Fld label="사회복지사 의견">
            <Textarea
              rows={3}
              value={f.workerOpinion ?? ""}
              onChange={(e) => setF((s) => ({ ...s, workerOpinion: e.target.value }))}
            />
          </Fld>
          <Fld label="재사정 결과">
            <Sel
              value={f.result}
              onChange={(v) => setF((s) => ({ ...s, result: v }))}
              options={RESULTS}
            />
          </Fld>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function Sel({
  value,
  onChange,
  options,
}: {
  value?: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="선택" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
