import { useEffect, useMemo, useRef, useState } from "react";
import { toKstDate } from "@/lib/log-time";
import { supabase } from "@/integrations/supabase/client";
import { logView } from "@/lib/view-log";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Send, Sparkles, Package } from "lucide-react";
import { isTerminated, type Client, type ActivityLog, type Provision, type OrgRow } from "@/lib/case-types";
import { BulkCaseDialog } from "./BulkCaseDialog";
import { getAiBlockedIds, isAiBlocked } from "@/lib/ai-consent";
import { AI_CODE_RULE, aiLabel, codifyNamesDetailed, restoreNames, type NameHit } from "@/lib/ai-names";
import { maskedName, useNameMask } from "@/lib/name-mask-context";
import { AiModelBadge } from "@/components/AiModelBadge";
import { modelFromResponse } from "@/lib/ai-model";
import { formatLogDateTime } from "@/lib/log-time";
import { clearResourceChat, getResourceChat, setResourceChat } from "@/lib/resource-chat-cache";
import { buildProvidedMap, formatProvidedForContext, matchWarnings, type ProvidedHit } from "@/lib/provided-items";

// ── 자원 배분 AI 채팅 패널 ──────────────────────────────────────
const RECENT_MONTHS = 12;
// 상담 줄은 대상자당 짧게 줄여 넣는다. 상한을 넘으면 오래 연락하지 않은 대상자부터 빠지고 화면에 알린다.
const CONTEXT_MAX_CHARS = 120000;

// 본문 속 줄바꿈을 공백으로 바꿔 한 줄로 만든다. 컨텍스트는 대상자 한 명이 한 줄이어야
// 전송 직전에 AI 거부 대상자를 줄 단위로 정확히 걸러낼 수 있다(여러 줄이면 본문 나머지 줄이 남는다).
const oneLine = (s: string | null | undefined, max: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

type ResourceChatMsg = {
  id: string;
  role: "user" | "ai";
  text: string;
  hits?: NameHit[];
  /** 이 답변을 실제로 만든 AI 모델(응답에 들어 있는 값) */
  model?: string | null;
  /** 이 답변을 만든 시각(밀리초) — 이동했다 돌아왔을 때 언제 만든 추천인지 보여 준다 */
  at?: number;
  recommendedClients?: { client_id: string; client_name: string; reason: string; warnings?: ProvidedHit[] }[];
  citedLogs?: { log_id: string; client_id: string; client_name: string; date: string; summary: string }[];
};

type CitedLogView = {
  log_id: string;
  client_name: string;
  date: string;
  summary: string;
  fullNote?: string;
};

export function ResourceChatPanel({
  clients,
  logs,
  provisions,
  org,
  workerName,
  onSelectClient,
  onChanged,
  onLogsChanged,
}: {
  clients: Client[];
  logs: ActivityLog[];
  provisions: Provision[];
  org: OrgRow | null;
  workerName: string;
  onSelectClient: (id: string) => void;
  onChanged: () => void;
  onLogsChanged?: () => Promise<void>;
}) {
  const [input, setInput] = useState("");
  // 다른 화면에 갔다 돌아와도 추천 결과가 남도록, 메모리에 보관한 대화를 불러온다
  const [messages, setMessages] = useState<ResourceChatMsg[]>(() => (org ? getResourceChat<ResourceChatMsg>(org.id) : []));
  // 추천 대상자를 눌렀을 때 뜨는 요약 창
  const [detailRec, setDetailRec] = useState<NonNullable<ResourceChatMsg["recommendedClients"]>[number] | null>(null);
  // 메시지 추가: 화면이 닫힌 뒤 응답이 도착해도 보관본에 들어가도록 보관본을 기준으로 이어 붙인다
  const orgKey = org?.id;
  const addMessages = (updater: (prev: ResourceChatMsg[]) => ResourceChatMsg[]) => {
    if (!orgKey) {
      setMessages(updater);
      return;
    }
    const next = updater(getResourceChat<ResourceChatMsg>(orgKey));
    setResourceChat(orgKey, next);
    setMessages(next);
  };
  const [busy, setBusy] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkClients, setBulkClients] = useState<Client[]>([]);
  const [viewLog, setViewLog] = useState<CitedLogView | null>(null);
  const [viewLogLoading, setViewLogLoading] = useState(false);
  // DB 조회 중 dialog를 닫아도 완료 후 재오픈되지 않도록 추적
  const activeLogIdRef = useRef<string | null>(null);
  // 컨텍스트를 미리 빌드해두어 질문 시 DB 조회 없이 바로 Gemini 호출
  const [cachedContext, setCachedContext] = useState<string | null>(null);
  // 측정: AI에 실제로 전달되는 대상자 수(5만 자 상한을 넘으면 오래 연락하지 않은 대상자부터 잘린다)
  const [ctxStats, setCtxStats] = useState<{
    eligible: number;
    included: number;
    totalChars: number;
    clientsTotal: number;
    blocked: number;
  } | null>(null);
  // 대상자별로 최근 12개월 기록에서 찾은 "이미 제공한 물품" — AI 추천 뒤 같은 물품이 있으면 경고하는 데 쓴다
  const providedRef = useRef<Map<string, ProvidedHit[]>>(new Map());
  const bottomRef = useRef<HTMLDivElement>(null);

  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const { hidden } = useNameMask();
  // AI는 대상자 번호로 답하므로 화면에 보일 때 이름으로 되돌린다(이름 숨기기를 켠 경우는 번호 그대로)
  const fmt = (t: string) => (hidden ? t : restoreNames(t, clients));
  const nameOf = (id: string, fallback: string) => {
    const c = clientById.get(id);
    return c ? maskedName(c, hidden) : fmt(fallback);
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 패널 마운트 또는 clients/provisions 변경 시 컨텍스트 미리 빌드
  useEffect(() => {
    if (!org) return;
    try {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - RECENT_MONTHS);
      const cutoffStr = cutoff.toLocaleDateString("en-CA");

      // 상담기록은 화면에 이미 불러온 전체 기록(logs)을 쓴다 → DB를 다시 조회하지 않고, 기록이 늘면 자동으로 반영된다.
      const logsByClient = new Map<string, ActivityLog[]>();
      for (const l of logs) {
        if (toKstDate(l.created_at) < cutoffStr) continue;
        const arr = logsByClient.get(l.client_id);
        if (arr) arr.push(l);
        else logsByClient.set(l.client_id, [l]);
      }
      for (const arr of logsByClient.values()) {
        arr.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)); // 최신순
      }
      const recentProvs = provisions.filter((p) => p.provided_at >= cutoffStr);
      // 이미 제공한 물품: 최근 상담 몇 건만이 아니라 12개월 전체 기록에서 코드가 먼저 찾아 AI에 힌트로 준다
      const providedMap = buildProvidedMap({ logs: [...logsByClient.values()].flat(), provisions: recentProvs, cutoffDate: cutoffStr });
      providedRef.current = providedMap;

      const contextEntries: { line: string; last: string }[] = [];
      for (const c of clients) {
        if (isTerminated(c)) continue; // 종결 대상자는 추천에서 제외
        if (isAiBlocked(c)) continue; // AI 활용을 거부한 대상자는 제외
        const cLogs = logsByClient.get(c.id) ?? [];
        const cProvs = recentProvs.filter((p) => p.client_id === c.id);
        if (cLogs.length === 0 && cProvs.length === 0 && !c.summary) continue;

        let line = `[${aiLabel(c)}|id:${c.id}] 위험도:${c.risk ?? "미분류"} 유형:${c.type}`;
        if (c.needs?.length) line += ` 욕구:${c.needs.slice(0, 3).join(",")}`;
        if (c.summary) line += ` 요약:${oneLine(c.summary, 60)}`;
        if (cLogs.length) {
          line += ` 최근상담:`;
          line += cLogs
            .slice(0, 3)
            .map((l) => `{id:${l.id},날짜:${toKstDate(l.created_at)},내용:${oneLine(l.note, 120)}}`)
            .join(";");
        }
        if (cProvs.length) {
          // 비고도 함께 준다(구체적인 물품을 비고에 적는 경우가 많다). 줄이 길어지지 않게 40자까지만.
          line += ` 최근제공:${cProvs
            .slice(0, 5)
            .map((p) => {
              const memo = (p.note ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
              return `${p.provided_at} ${p.title}${memo ? `(비고:${memo})` : ""}`;
            })
            .join(",")}`;
        }
        line += formatProvidedForContext(providedMap.get(c.id));
        const last = [(cLogs[0] ? toKstDate(cLogs[0].created_at) : ""), ...cProvs.map((p) => p.provided_at)].reduce(
          (a, b) => (a > b ? a : b),
        );
        contextEntries.push({ line, last });
      }
      // 상한을 넘어도 최근 활동이 있는 대상자가 먼저 들어가도록 정렬
      contextEntries.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
      // 상한 안에 줄이 몇 개나 온전히 들어가는지(줄 중간에서 자르지 않는다)
      let used = 0;
      let included = 0;
      for (let i = 0; i < contextEntries.length; i++) {
        const add = contextEntries[i].line.length + (i > 0 ? 1 : 0);
        if (used + add > CONTEXT_MAX_CHARS) break;
        used += add;
        included++;
      }
      const stats = {
        eligible: contextEntries.length,
        included,
        totalChars: contextEntries.reduce((s, e) => s + e.line.length + 1, -1),
        clientsTotal: clients.length,
        blocked: clients.filter((c) => isAiBlocked(c)).length,
      };
      console.info("[자원배분] AI에 전달하는 대상자", stats);
      setCtxStats(stats);
      setCachedContext(contextEntries.slice(0, included).map((e) => e.line).join("\n"));
    } catch (e) {
      console.warn("[자원배분] 컨텍스트 생성 실패:", e);
      setCachedContext("");
    }
  }, [org?.id, clients, provisions, logs]);

  const systemPrompt =
    "당신은 한국 사회복지관 사례관리팀의 AI 어시스턴트입니다. " +
    "담당자가 자원 배분, 지원 대상 선정, 서비스 계획 등을 묻는 질문에 답합니다.\n" +
    "제공된 [대상자 현황]을 참고해 구체적·실용적으로 답변하세요.\n\n" +
    "대상자 현황의 각 줄은 [대상자|id:UUID] 형식입니다. " + AI_CODE_RULE + " " +
    "client_id 필드에는 반드시 id: 뒤의 UUID 값을 그대로 사용하세요.\n" +
    "질문에 특정 대상자가 번호(예: JN0018)로 적혀 있으면 그 대상자만 답하세요. 번호가 'JN0018/JN0100'처럼 '/'로 이어져 있으면 이름이 같은 후보들이므로 각 대상자를 구분해서 답하세요. 번호로 바뀌지 않은 이름이 질문에 있으면 그 이름과 글자가 정확히 같은 대상자만 근거로 삼고, 비슷한 이름(한 글자 차이 등)의 다른 대상자를 임의로 포함하지 마세요. 해당 대상자를 찾을 수 없으면 추측하지 말고 answer에서 확인을 요청하세요.\n\n" +
    "물품·서비스 중복 방지 규칙:\n" +
    "- 대상자 줄의 `이미제공:`은 최근 12개월 기록에서 이미 지급·배분·전달·제공한 것으로 확인된 물품(날짜)입니다. 질문의 물품이 `이미제공`에 있거나, 최근상담·최근제공에 이미 지급·배분·전달했다는 내용이 있으면 그 대상자에게 그 물품을 추천하지 마세요.\n" +
    "- `재필요언급`이 붙어 있거나 제공 이후 날짜의 기록에 다시 필요하다는 내용이 있으면 추천할 수 있지만, reason에 이전에 제공한 사실(날짜)과 다시 필요한 근거를 함께 쓰세요.\n" +
    "- 같은 기록에 '필요'와 '지급 완료'가 함께 있으면 날짜순으로 마지막 상태를 따르세요. 지급 여부가 불확실하면 reason에 '지급 여부 확인 필요'라고 쓰세요.\n\n" +
    "반드시 아래 JSON 형식으로만 답변하세요:\n" +
    '{"answer":"답변(평문)","recommended_clients":[{"client_id":"UUID 값","client_name":"대상자 번호 또는 이름","reason":"선정이유 한 줄"}],"cited_logs":[{"log_id":"UUID 값","client_id":"UUID 값","client_name":"대상자 번호 또는 이름","date":"YYYY-MM-DD","summary":"참고내용 한 줄"}]}\n' +
    "recommended_clients와 cited_logs는 해당 없으면 빈 배열.";

  /** 참고·근거 기록 한 건을 창으로 연다(다른 칩을 눌렀거나 창을 닫았으면 늦게 온 결과는 무시) */
  async function openCitedLog(l: { log_id: string; client_id: string; client_name: string; date: string; summary: string }) {
    const logId = l.log_id;
    activeLogIdRef.current = logId;
    setViewLog({ log_id: logId, client_name: nameOf(l.client_id, l.client_name), date: l.date, summary: fmt(l.summary) });
    setViewLogLoading(true);
    const { data } = await supabase.from("activity_logs").select("note").eq("id", logId).maybeSingle();
    if (activeLogIdRef.current !== logId) return;
    setViewLog({ log_id: logId, client_name: nameOf(l.client_id, l.client_name), date: l.date, summary: fmt(l.summary), fullNote: data?.note });
    setViewLogLoading(false);
  }

  async function ask() {
    if (!input.trim() || busy || !org || cachedContext === null) return;
    const userText = input.trim();
    setInput("");
    setBusy(true);
    logView({ action: "AI 자원배분 질문" });
    // 질문 속 대상자 이름을 번호로 바꾸고, 어떤 대상자로 인식했는지 질문 아래에 보여 준다
    const coded = codifyNamesDetailed(userText, clients);
    addMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", text: userText, hits: coded.hits }]);

    try {
      // 패널을 연 뒤 다른 담당자가 거부로 바꾼 대상자를 전송 직전에 다시 걸러낸다
      const blocked = await getAiBlockedIds(supabase, { orgId: org.id });
      const ctx = blocked.size
        ? cachedContext
            .split("\n")
            .filter((line) => ![...blocked].some((id) => line.includes(`|id:${id}]`)))
            .join("\n")
        : cachedContext;
      const userPrompt = `[대상자 현황 (최근 ${RECENT_MONTHS}개월)]\n${ctx}\n\n[질문]\n${coded.text}`;

      const { data, error } = await supabase.functions.invoke("gemini", {
        // task: 자원 배분은 정확도가 중요해 서버가 작업별 모델(GEMINI_MODEL_RESOURCE)로 먼저 호출한다(실패하면 기본 모델로 자동 전환)
        body: { system: systemPrompt, user: userPrompt, json: true, task: "resource" },
      });

      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);

      let parsed: {
        answer: string;
        recommended_clients: { client_id: string; client_name: string; reason: string }[];
        cited_logs: { log_id: string; client_id: string; client_name: string; date: string; summary: string }[];
      };
      try {
        const raw = typeof data?.text === "string" ? data.text : JSON.stringify(data);
        const m = raw.match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : { answer: raw, recommended_clients: [], cited_logs: [] };
      } catch {
        parsed = { answer: data?.text ?? "응답 파싱 실패", recommended_clients: [], cited_logs: [] };
      }

      addMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "ai",
          text: parsed.answer || "응답이 없습니다.",
          model: modelFromResponse(data),
          at: Date.now(),
          recommendedClients: (parsed.recommended_clients ?? [])
            .filter((r) => r.client_id)
            .map((r) => ({ ...r, warnings: matchWarnings(providedRef.current.get(r.client_id), userText) })),
          citedLogs: (parsed.cited_logs ?? []).filter((l) => l.log_id),
        },
      ]);
    } catch (e) {
      addMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "ai", text: "오류: " + (e as Error).message },
      ]);
    } finally {
      setBusy(false);
    }
  }

  // 추천 대상자 요약 창에 보여 줄 최근 상담·제공이력(이미 불러온 데이터에서 골라 쓴다)
  const detailClient = detailRec ? clientById.get(detailRec.client_id) : undefined;
  const detailLogs = useMemo(
    () =>
      !detailRec
        ? []
        : logs
            .filter((l) => l.client_id === detailRec.client_id)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, 3),
    [detailRec, logs],
  );
  const detailProvs = useMemo(
    () =>
      !detailRec
        ? []
        : provisions
            .filter((p) => p.client_id === detailRec.client_id)
            .sort((a, b) => b.provided_at.localeCompare(a.provided_at))
            .slice(0, 5),
    [detailRec, provisions],
  );

  return (
    <div className="mt-4 rounded-lg border border-border bg-card flex flex-col" style={{ minHeight: "280px", maxHeight: "60dvh" }}>
      {/* 헤더 */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">자원 배분 AI 도우미</span>
        <span className="text-xs text-muted-foreground ml-1">최근 {RECENT_MONTHS}개월 상담·제공이력 기반</span>
        <AiModelBadge task="resource" model={[...messages].reverse().find((m) => m.role === "ai" && m.model)?.model ?? null} />
        {messages.length > 0 && !busy && (
          <button
            type="button"
            className="text-[11px] text-muted-foreground underline hover:text-foreground"
            onClick={() => {
              if (!confirm("지금까지의 추천 결과를 모두 지울까요?")) return;
              if (org) clearResourceChat(org.id);
              setMessages([]);
            }}
          >
            추천 지우기
          </button>
        )}
        {ctxStats && (
          <span
            className={`ml-auto text-[11px] ${ctxStats.included < ctxStats.eligible ? "text-amber-700" : "text-muted-foreground"}`}
            title={`최근 ${RECENT_MONTHS}개월 동안 상담·제공 기록이 있는 대상자 ${ctxStats.eligible}명 중 ${ctxStats.included}명을 AI에 전달했어요. (전체 ${ctxStats.clientsTotal}명, AI 거부 ${ctxStats.blocked}명 제외, 전달 데이터 ${ctxStats.totalChars.toLocaleString()}자 / 상한 ${CONTEXT_MAX_CHARS.toLocaleString()}자)`}
          >
            AI 반영 {ctxStats.included}명 / 대상 {ctxStats.eligible}명
            {ctxStats.included < ctxStats.eligible && ` · 오래 연락하지 않은 ${ctxStats.eligible - ctxStats.included}명 제외`}
          </span>
        )}
      </div>

      {/* 메시지 목록 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">
            예: "오늘 삼계탕 30개가 들어왔는데 누구한테 나가면 좋을까?"
          </p>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex flex-col items-end gap-1">
              <div className="max-w-[70%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-3 py-2 text-sm">
                {m.text}
              </div>
              {m.hits && m.hits.length > 0 && (
                <p className="max-w-[70%] text-right text-[10px] text-muted-foreground">
                  인식한 대상자:{" "}
                  {m.hits
                    .map(
                      (h) =>
                        `${h.from} → ${h.clients
                          .map((c) => (hidden ? (c.client_code ?? "대상자") : `${c.name}(${c.client_code})`))
                          .join(" / ")}`,
                    )
                    .join(", ")}
                </p>
              )}
            </div>
          ) : (
            <div key={m.id} className="flex justify-start">
              <div className="max-w-[88%] space-y-2">
                <div className="rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
                  {fmt(m.text)}
                </div>
                {(m.model || m.at) && (
                  <div className="flex items-center gap-2">
                    {m.model && <AiModelBadge task="resource" model={m.model} />}
                    {m.at && (
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(m.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}에 만든 추천
                      </span>
                    )}
                  </div>
                )}
                {/* 추천 대상자 */}
                {m.recommendedClients && m.recommendedClients.length > 0 && (
                  <div className="rounded-lg border border-border bg-card p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">추천 대상자 {m.recommendedClients.length}명</span>
                      {org && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-xs px-2"
                          onClick={() => {
                            const sel = m.recommendedClients!
                              .map((r) => clientById.get(r.client_id))
                              .filter((c): c is Client => !!c);
                            if (sel.length === 0) return;
                            setBulkClients(sel);
                            setBulkOpen(true);
                          }}
                        >
                          <Package className="h-3 w-3 mr-1" />
                          일괄 제공이력 등록
                        </Button>
                      )}
                    </div>
                    <div className="space-y-1">
                      {m.recommendedClients.map((r, i) => (
                        <div key={i} className="text-xs">
                          <div className="flex gap-2 items-start">
                            <button
                              className="font-medium text-primary hover:underline shrink-0"
                              onClick={() => setDetailRec(r)}
                              title="눌러서 추천 이유와 최근 기록 요약 보기"
                            >
                              {nameOf(r.client_id, r.client_name)}
                            </button>
                            <span className="text-muted-foreground">{fmt(r.reason)}</span>
                          </div>
                          {/* 질문한 물품을 이미 제공한 기록이 있으면 경고(다시 필요하다는 기록이 뒤에 있으면 주황, 없으면 빨강) */}
                          {r.warnings?.map((w, j) => (
                            <div
                              key={j}
                              className={`mt-0.5 ml-1 text-[11px] ${w.laterNeedDate ? "text-amber-700" : "text-destructive"}`}
                            >
                              ⚠ 이미 제공 기록: {w.item} · {w.date}({w.source})
                              {w.laterNeedDate
                                ? ` · 이후 ${w.laterNeedDate}에 다시 필요하다는 기록이 있어요`
                                : " · 이미 지급했는지 확인하세요"}
                              {w.logId && (
                                <button
                                  className="ml-1 underline"
                                  title={fmt(w.snippet)}
                                  onClick={() =>
                                    void openCitedLog({ log_id: w.logId!, client_id: r.client_id, client_name: r.client_name, date: w.date, summary: w.snippet })
                                  }
                                >
                                  근거 보기
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* 인용 기록 */}
                {m.citedLogs && m.citedLogs.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[10px] text-muted-foreground">참고 기록:</span>
                    {m.citedLogs.map((l, i) => (
                      <button
                        key={i}
                        onClick={() => void openCitedLog(l)}
                        className="text-[10px] px-2 py-0.5 rounded-full border border-border hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                        title={fmt(l.summary)}
                      >
                        {nameOf(l.client_id, l.client_name)} · {l.date}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        )}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-tl-sm bg-muted px-3 py-2">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 입력창 */}
      <div className="border-t border-border p-3 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              const t = e.target;
              t.style.height = "auto";
              t.style.height = Math.min(t.scrollHeight, 120) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask();
              }
            }}
            rows={1}
            disabled={busy || cachedContext === null}
            placeholder={cachedContext === null ? "데이터 불러오는 중..." : "자원 배분 관련 질문 입력 (Enter 전송, Shift+Enter 줄바꿈)"}
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            style={{ resize: "none", minHeight: "36px", maxHeight: "120px", overflowY: "auto" }}
          />
          <Button
            type="button"
            onClick={ask}
            disabled={busy || !input.trim() || cachedContext === null}
            className="h-9 shrink-0"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* 일괄 제공이력 등록 다이얼로그 (AI 추천 대상자 사용) */}
      {org && (
        <BulkCaseDialog
          open={bulkOpen && bulkClients.length > 0}
          onOpenChange={setBulkOpen}
          clients={bulkClients}
          orgId={org.id}
          workerName={workerName}
          onSaved={async () => {
            await onLogsChanged?.();
            onChanged();
          }}
        />
      )}

      {/* 참고 기록 상세 보기 다이얼로그 */}
      {/* 추천 대상자 요약 창: 이동하지 않고 이유·최근 기록을 확인한다 */}
      <Dialog open={!!detailRec} onOpenChange={(v) => { if (!v) setDetailRec(null); }}>
        <DialogContent className="max-w-lg max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">{detailRec ? nameOf(detailRec.client_id, detailRec.client_name) : ""}</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {detailClient
                ? `위험도 ${detailClient.risk ?? "미분류"} · 유형 ${detailClient.type}${detailClient.needs?.length ? ` · 욕구 ${detailClient.needs.slice(0, 3).join(", ")}` : ""}`
                : "대상자 정보를 찾을 수 없어요."}
            </DialogDescription>
          </DialogHeader>
          {detailRec && (
            <div className="space-y-3 text-sm">
              <section>
                <h4 className="text-xs font-medium text-muted-foreground mb-1">추천 이유</h4>
                <p className="text-sm">{fmt(detailRec.reason)}</p>
              </section>
              {detailRec.warnings && detailRec.warnings.length > 0 && (
                <section className="rounded-md border border-border p-2 space-y-1">
                  {detailRec.warnings.map((w, j) => (
                    <p key={j} className={`text-xs ${w.laterNeedDate ? "text-amber-700" : "text-destructive"}`}>
                      ⚠ 이미 제공 기록: {w.item} · {w.date}({w.source})
                      {w.laterNeedDate ? ` · 이후 ${w.laterNeedDate}에 다시 필요하다는 기록이 있어요` : " · 이미 지급했는지 확인하세요"}
                    </p>
                  ))}
                </section>
              )}
              <section>
                <h4 className="text-xs font-medium text-muted-foreground mb-1">최근 상담 {detailLogs.length}건</h4>
                {detailLogs.length === 0 ? (
                  <p className="text-xs text-muted-foreground">상담기록이 없어요.</p>
                ) : (
                  <div className="space-y-2">
                    {detailLogs.map((l) => (
                      <div key={l.id} className="rounded-md border border-border p-2">
                        <div className="text-[11px] text-muted-foreground mb-0.5">
                          {formatLogDateTime(l)} · {l.method}
                        </div>
                        <p className="text-xs whitespace-pre-wrap">{l.note || "(내용 없음)"}</p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <section>
                <h4 className="text-xs font-medium text-muted-foreground mb-1">최근 제공이력 {detailProvs.length}건</h4>
                {detailProvs.length === 0 ? (
                  <p className="text-xs text-muted-foreground">제공이력이 없어요.</p>
                ) : (
                  <ul className="space-y-0.5">
                    {detailProvs.map((p) => (
                      <li key={p.id} className="text-xs">
                        {p.provided_at} · {p.title}
                        {p.quantity ? ` · ${p.quantity}` : ""}
                        {p.note ? <span className="text-muted-foreground"> ({p.note})</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <p className="text-[11px] text-muted-foreground">상담 화면으로 이동해도 추천 결과는 남아 있어요. 돌아오면 이어서 볼 수 있어요.</p>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" size="sm" onClick={() => setDetailRec(null)}>닫기</Button>
            <Button
              size="sm"
              onClick={() => {
                if (!detailRec) return;
                const id = detailRec.client_id;
                setDetailRec(null);
                onSelectClient(id);
              }}
            >
              전체 상담 내용 보기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!viewLog} onOpenChange={(v) => { if (!v) { activeLogIdRef.current = null; setViewLog(null); setViewLogLoading(false); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">
              {viewLog?.client_name} · {viewLog?.date}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              AI가 인용한 상담 기록
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm min-h-[80px] whitespace-pre-wrap leading-relaxed">
            {viewLogLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>불러오는 중...</span>
              </div>
            ) : (
              viewLog?.fullNote ?? viewLog?.summary ?? ""
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { activeLogIdRef.current = null; setViewLog(null); setViewLogLoading(false); }}>닫기</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
