import { createGeminiProvider, GEMINI_CHAT_MODEL } from "@/lib/ai-gateway.server";
import { buildCompanionPrompt } from "@/lib/companion-prompt";
import { resolveTurnState } from "@/lib/chat-turn";
import { createFileRoute } from "@tanstack/react-router";
import { convertToModelMessages, streamText, type UIMessage } from "ai";

type ChatRequestBody = {
  messages?: unknown;
  sessionId?: unknown;
  companionName?: unknown;
  seniorName?: unknown;
  trigger?: unknown; // "submit-message" | "regenerate-message" (재시도)
};

// 스트림 도중 Gemini 오류는 기본 처리로는 "An error occurred."로만 전달돼 화면이 원인을 구분할 수 없다.
// ChatWindow가 알아보는 키워드로 바꿔서 한도 초과·과부하 안내가 제대로 나오게 한다.
function describeStreamError(error: unknown): string {
  const s = String((error as Error)?.message ?? error).toLowerCase();
  console.error("[chat] stream error:", s.slice(0, 300));
  if (s.includes("timeout") || s.includes("aborted") || (error as Error)?.name === "TimeoutError") return "stream_timeout";
  if (s.includes("429") || s.includes("quota") || s.includes("resource_exhausted")) return "quota_exceeded";
  if (s.includes("503") || s.includes("unavailable") || s.includes("overloaded") || s.includes("high demand")) {
    return "503 unavailable";
  }
  return "stream_error";
}

// AI에 보내는 대화 수 상한. 화면의 전체 기록을 매번 보내면 비용·지연이 계속 늘고 결국 요청이 실패한다.
const MODEL_CONTEXT_MESSAGES = 40;

// 최근 대화만 남기되, Gemini는 사용자 메시지로 시작해야 하므로 맨 앞의 AI 답변은 버린다.
function recentForModel(msgs: UIMessage[]): UIMessage[] {
  const recent = msgs.slice(-MODEL_CONTEXT_MESSAGES);
  const firstUser = recent.findIndex((m) => m.role === "user");
  return firstUser > 0 ? recent.slice(firstUser) : recent;
}

function textOf(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

// ── 입력 검증 ──────────────────────────────────────────────
const MAX_MESSAGES = 200; // 이보다 많으면 최근 것만 쓴다
const MAX_TEXT_CHARS = 4000; // 메시지 하나가 이보다 길면 자른다 (옛 대화는 거절하지 않고 자르기만 함)
const MAX_USER_TURN_CHARS = 2000; // 어르신이 이번에 보낸 말씀이 이보다 길면 거절한다
const MAX_NAME_CHARS = 20;
const GEMINI_TIMEOUT_MS = 40_000;

// 브라우저가 보낸 대화를 "어르신/AI의 글자"만 남기고 걸러낸다.
// system 역할, 파일·도구 같은 글자가 아닌 부분은 버려서 프롬프트에 지시를 끼워 넣거나 비용을 일으키는 길을 막는다.
function sanitizeMessages(raw: unknown[]): UIMessage[] {
  const out: UIMessage[] = [];
  for (const item of raw.slice(-MAX_MESSAGES)) {
    if (!item || typeof item !== "object") continue;
    const m = item as { id?: unknown; role?: unknown; parts?: unknown };
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (!Array.isArray(m.parts)) continue;
    const text = m.parts
      .map((p) => {
        const part = p as { type?: unknown; text?: unknown };
        return part?.type === "text" && typeof part.text === "string" ? part.text : "";
      })
      .join("")
      .slice(0, MAX_TEXT_CHARS);
    if (!text.trim()) continue;
    out.push({
      id: typeof m.id === "string" && m.id ? m.id.slice(0, 100) : crypto.randomUUID(),
      role: m.role,
      parts: [{ type: "text", text }],
    });
  }
  return out;
}

// 이름은 줄바꿈·제어문자를 지우고 짧게 자른다 (프롬프트 한 줄에 들어가는 값이라 지시문을 끼워 넣지 못하게)
function cleanName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  // 제어문자(0~31, 127)와 줄·문단 구분 문자(8232, 8233)는 공백으로 바꾼다
  const cleaned = Array.from(raw)
    .map((ch) => { const c = ch.charCodeAt(0); return c < 32 || c === 127 || c === 8232 || c === 8233 ? " " : ch; })
    .join("")
    .replace(/ +/g, " ")
    .trim()
    .slice(0, MAX_NAME_CHARS);
  return cleaned || fallback;
}

async function persist(sessionId: string, role: "user" | "assistant", content: string) {
  if (!content) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // Keep the senior row fresh for the monitoring system.
  // upsert 대신 update 사용 — care_context 등 기존 컬럼을 덮어쓰지 않도록.
  await supabaseAdmin
    .from("seniors")
    .update({ last_active_at: new Date().toISOString() })
    .eq("session_id", sessionId);
  const { error } = await supabaseAdmin
    .from("chat_messages")
    .insert({ session_id: sessionId, role, content });
  if (error) console.error(`[chat] persist ${role} failed:`, error.message);
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as ChatRequestBody | null;
        if (!body || typeof body !== "object") {
          return new Response("Invalid body", { status: 400 });
        }
        const { messages, sessionId, companionName, seniorName, trigger } = body;
        if (!Array.isArray(messages)) {
          return new Response("Messages are required", { status: 400 });
        }
        if (typeof sessionId !== "string" || !sessionId || sessionId.length > 100) {
          return new Response("sessionId is required", { status: 400 });
        }
        const name = cleanName(companionName, "복순이");

        if (!process.env.GEMINI_API_KEY) {
          return new Response("AI is not configured", { status: 500 });
        }

        const uiMessages = sanitizeMessages(messages);
        const lastUserMsg = [...uiMessages].reverse().find((m) => m.role === "user");
        if (!lastUserMsg || uiMessages[uiMessages.length - 1]?.role !== "user") {
          return new Response("A user message is required", { status: 400 });
        }
        if (textOf(lastUserMsg).length > MAX_USER_TURN_CHARS) {
          return new Response("too_long", { status: 400 });
        }

        // ── S-1: sessionId DB 검증 + 케어 데이터 로드 (DB 장애 시 fail-open) ──
        let sr: { care_context: unknown; care_keywords: unknown; staff_name: unknown; staff_phone: unknown; name: unknown } | null = null;
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data, error: authError } = await supabaseAdmin
            .from("seniors")
            .select("care_context, care_keywords, staff_name, staff_phone, name")
            .eq("session_id", sessionId)
            .maybeSingle();
          if (authError) {
            // DB 쿼리 오류 → fail-open (어르신 대화 중단 방지)
            console.error("[chat] auth query error, allowing:", authError.message);
          } else if (data === null) {
            // DB에 없는 sessionId — 미승인 요청 차단
            return new Response("unauthorized", { status: 403 });
          } else {
            sr = data;
          }
        } catch (authErr) {
          // 연결 장애 시 fail-open
          console.error("[chat] auth check failed, allowing:", authErr);
        }

        // ── 승인 확인: 해제·삭제·미승인 기기는 서버에서 차단 (DB 장애 시에는 통과) ──
        const { isSessionApproved } = await import("@/lib/session-guard.server");
        if ((await isSessionApproved(sessionId)) === false) {
          return new Response("not_approved", { status: 403 });
        }

        // ── S-2: Rate Limiting (Upstash — env 없으면 skip) ──────────────────
        const { allowRequest } = await import("@/lib/rate-limit.server");
        if (!(await allowRequest({ prefix: "bdt:chat", key: sessionId, limit: 30, window: "60s" }))) { // 분당 30회 (어르신 여유롭게)
          return new Response("too_many_requests", { status: 429 });
        }

        // 어르신 성함은 DB에 저장된 값을 우선 쓴다. 브라우저가 보낸 값은 DB에 없을 때만 (프롬프트에 임의 글자를 넣지 못하게).
        const senior = cleanName(sr?.name ?? seniorName, "");
        const careContext = (sr?.care_context as string | null) ?? null;
        const careKeywords = Array.isArray(sr?.care_keywords) ? (sr.care_keywords as string[]) : [];
        const staffName = (sr?.staff_name as string | null) ?? undefined;
        const staffPhone = (sr?.staff_phone as string | null) ?? undefined;

        // 직전 기록을 이번 메시지를 저장하기 전에 조회한다. 그래야 "직전 대화 시각"이 잡히고
        // (오랜만에 온 "안녕"을 작별로 오해하지 않도록 프롬프트에 전달), 재시도 때 이미 저장된 메시지인지 알 수 있다.
        // 조회가 실패해도 대화는 계속하고, 이때는 메시지를 잃지 않도록 저장하는 쪽으로 처리한다.
        const lastUser = [...uiMessages].reverse().find((m) => m.role === "user");
        const userText = textOf(lastUser);
        let turn: ReturnType<typeof resolveTurnState> = { alreadySaved: false, lastMessageAt: undefined };
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: recent } = await supabaseAdmin
            .from("chat_messages")
            .select("role, content, created_at")
            .eq("session_id", sessionId)
            .order("created_at", { ascending: false })
            .limit(3);
          turn = resolveTurnState(recent ?? [], trigger === "regenerate-message", userText);
        } catch (lastErr) {
          console.error("[chat] recent messages lookup failed, skipping:", lastErr);
        }
        const lastMessageAt = turn.lastMessageAt;

        // 재시도(regenerate)는 이미 저장된 같은 사용자 메시지를 다시 보내는 것이라 저장하지 않는다.
        if (!turn.alreadySaved) {
          await persist(sessionId, "user", userText);
        }

        const gemini = createGeminiProvider();
        let result;
        try {
          result = streamText({
            model: gemini(GEMINI_CHAT_MODEL),
            system: buildCompanionPrompt(name, senior, careContext ?? undefined, careKeywords, staffName, staffPhone, lastMessageAt),
            messages: await convertToModelMessages(recentForModel(uiMessages)),
            // 응답이 오래 안 오면 끊는다 (화면에도 별도의 무응답 제한이 있다)
            abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
          });
        } catch (err) {
          const errStr = String((err as Error)?.message ?? err);
          console.error(`[chat] streamText failed (model=${GEMINI_CHAT_MODEL}):`, errStr);
          if (errStr.toLowerCase().includes("429") || errStr.toLowerCase().includes("quota") || errStr.toLowerCase().includes("resource_exhausted")) {
            return new Response("quota_exceeded", { status: 429 });
          }
          throw err;
        }

        return result.toUIMessageStreamResponse({
          originalMessages: uiMessages,
          onError: describeStreamError,
          onFinish: async ({ responseMessage }) => {
            await persist(sessionId, "assistant", textOf(responseMessage));
          },
        });
      },
    },
  },
});
