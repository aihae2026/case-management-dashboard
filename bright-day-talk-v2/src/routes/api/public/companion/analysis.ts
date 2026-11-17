import { createFileRoute } from "@tanstack/react-router";
import { createGeminiProvider, GEMINI_CHAT_MODEL } from "@/lib/ai-gateway.server";
import { generateObject } from "ai";
import { kstDate } from "@/lib/utils";
import { ANALYSIS_CRISIS_KEYWORDS } from "@/lib/crisis-keywords";
import { z } from "zod";

// Public integration API for the "통합사례관리 시스템" (case-management system).
// Given a phone number (matched against the elder registered in the chatbot),
// returns activity metrics, recent conversation, an AI summary/mood/risk
// assessment, and crisis flags — everything the case worker needs to see how
// the elder has been doing with the 복순이 companion.
//
// Auth: the caller must send `x-api-key: <COMPANION_API_KEY>`.
// Path: /api/public/companion/analysis
//
// Query params:
//   - phone: required, digits or formatted (010-...); we normalize to digits
//   - refresh: optional, "1" to bypass the cached analysis
//   - message_limit: optional (default 30, max 100)

// 위기 신호 목록은 어르신 화면의 고정 안내문과 같은 파일을 쓴다 (src/lib/crisis-keywords.ts)
const CRISIS_KEYWORDS = ANALYSIS_CRISIS_KEYWORDS;

const CACHE_TTL_MINUTES = 20;

const AnalysisSchema = z.object({
  summary: z.string().describe("최근 대화를 3~5문장으로 요약. 어르신의 상태와 감정 위주."),
  mood: z.enum(["매우 좋음", "좋음", "보통", "가라앉음", "매우 가라앉음"]),
  risk_level: z.enum(["안전", "관찰", "주의", "위험"]).describe("사례관리 관점의 위험도"),
  loneliness_score: z.number().min(0).max(10).describe("외로움 정도 (0=없음, 10=매우 심함)"),
  crisis_flags: z.array(z.string()).describe("발견된 위기 신호 짧게 나열 (없으면 빈 배열)"),
  health_concerns: z.array(z.string()).describe("어르신이 언급한 건강/신체 관련 걱정거리"),
  daily_life: z.array(z.string()).describe("식사, 수면, 집안 환경 등 생활 관련 특이사항"),
  topics: z.array(z.string()).max(6).describe("대화의 주요 주제 키워드"),
  recommendations: z.array(z.string()).describe("사례관리자에게 권하는 다음 행동 (짧게)"),
});

type Analysis = z.infer<typeof AnalysisSchema>;

function computeMetrics(messages: { role: string; content: string; created_at: string }[]) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const activeDays = new Set<string>();
  let userMsgs = 0;
  let botMsgs = 0;
  let last7 = 0;
  let last30 = 0;
  const crisisHits = new Set<string>();
  let lastAt: string | null = null;

  for (const m of messages) {
    const ts = new Date(m.created_at).getTime();
    if (!Number.isNaN(ts)) {
      const age = now - ts;
      if (age <= 7 * day) last7 += 1;
      if (age <= 30 * day) last30 += 1;
      activeDays.add(kstDate(m.created_at));
      if (!lastAt || m.created_at > lastAt) lastAt = m.created_at;
    }
    if (m.role === "user") {
      userMsgs += 1;
      for (const k of CRISIS_KEYWORDS) if (m.content.includes(k)) crisisHits.add(k);
    } else if (m.role === "assistant") {
      botMsgs += 1;
    }
  }
  return {
    last_message_at: lastAt,
    total_messages: messages.length,
    user_messages: userMsgs,
    assistant_messages: botMsgs,
    messages_last_7d: last7,
    messages_last_30d: last30,
    active_days_last_30d: activeDays.size,
    crisis_keyword_hits: Array.from(crisisHits),
  };
}

async function runAiAnalysis(
  recent: { role: string; content: string; created_at: string }[],
): Promise<Analysis | null> {
  if (!process.env.GEMINI_API_KEY || recent.length === 0) return null;
  const transcript = recent
    .slice(-40)
    .map((m) => `[${m.role === "user" ? "어르신" : "복순이"}] ${m.content}`)
    .join("\n");
  try {
    const gemini = createGeminiProvider();
    const { object } = await generateObject({
      model: gemini(GEMINI_CHAT_MODEL),
      schema: AnalysisSchema,
      system:
        "당신은 노인 사례관리 실무자를 돕는 보조 분석가입니다. 대화 기록을 바탕으로 어르신의 심리·생활·건강 상태를 간결하고 객관적으로 요약합니다. 추측은 피하고 대화에서 관찰되는 신호만 근거로 삼으세요.",
      prompt: `다음은 어르신과 AI 말벗 '복순이'의 최근 대화 기록입니다. 사례관리자가 참고할 수 있도록 정해진 스키마에 맞춰 한국어로 분석해 주세요.\n\n대화 기록:\n${transcript}`,
    });
    return object;
  } catch (err) {
    console.error("[companion analysis] AI failed:", err);
    return null;
  }
}

export const Route = createFileRoute("/api/public/companion/analysis")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const expected = process.env.COMPANION_API_KEY;
        if (!expected) {
          return Response.json({ error: "API not configured" }, { status: 500 });
        }
        // 일반 문자열 비교는 일치하는 앞부분의 길이를 응답 시간으로 흘리므로, 해시 후 시간 일정 비교를 쓴다
        const { createHash, timingSafeEqual } = await import("node:crypto");
        const digest = (s: string) => createHash("sha256").update(s).digest();
        const provided = request.headers.get("x-api-key") ?? "";
        if (!timingSafeEqual(digest(provided), digest(expected))) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const url = new URL(request.url);
        const phoneRaw = url.searchParams.get("phone") ?? "";
        const phone = phoneRaw.replace(/\D+/g, "");
        if (!phone) {
          return Response.json({ error: "phone is required" }, { status: 400 });
        }
        const refresh = url.searchParams.get("refresh") === "1";
        const messageLimit = Math.min(
          Math.max(parseInt(url.searchParams.get("message_limit") ?? "30", 10) || 30, 1),
          100,
        );

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: senior, error: seniorErr } = await supabaseAdmin
          .from("seniors")
          .select("id, session_id, phone, name, analysis, analysis_at, last_active_at, created_at")
          .eq("phone", phone)
          .order("last_active_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (seniorErr) {
          console.error("[companion analysis] senior lookup failed:", seniorErr.message);
          return Response.json({ error: "lookup failed" }, { status: 500 });
        }
        if (!senior) {
          return Response.json(
            {
              matched: false,
              message: "해당 전화번호로 등록된 복순이 사용자가 없습니다.",
            },
            { status: 404 },
          );
        }

        const { data: messages, error: msgErr } = await supabaseAdmin
          .from("chat_messages")
          .select("role, content, created_at")
          .eq("session_id", senior.session_id)
          .order("created_at", { ascending: false })
          .limit(messageLimit);

        if (msgErr) {
          console.error("[companion analysis] messages fetch failed:", msgErr.message);
          return Response.json({ error: "messages fetch failed" }, { status: 500 });
        }

        const recent = (messages ?? []).slice().reverse();
        const metrics = computeMetrics(recent);

        // Serve the cached analysis when it's fresh and no new user message
        // has arrived after it was generated.
        const cachedAt = senior.analysis_at ? new Date(senior.analysis_at).getTime() : 0;
        const isFresh =
          !refresh &&
          senior.analysis &&
          cachedAt > 0 &&
          Date.now() - cachedAt < CACHE_TTL_MINUTES * 60 * 1000 &&
          (!metrics.last_message_at || new Date(metrics.last_message_at).getTime() <= cachedAt);

        let analysis: Analysis | null = null;
        let analysis_generated_at = senior.analysis_at ?? null;
        if (isFresh) {
          analysis = senior.analysis as Analysis;
        } else {
          analysis = await runAiAnalysis(recent);
          if (analysis) {
            analysis_generated_at = new Date().toISOString();
            const { error: upErr } = await supabaseAdmin
              .from("seniors")
              .update({ analysis, analysis_at: analysis_generated_at })
              .eq("id", senior.id);
            if (upErr) console.error("[companion analysis] cache write failed:", upErr.message);
          }
        }

        return Response.json({
          matched: true,
          senior: {
            id: senior.id,
            name: senior.name,
            phone: senior.phone,
            first_seen_at: senior.created_at,
            last_active_at: senior.last_active_at,
          },
          metrics,
          analysis,
          analysis_generated_at,
          recent_messages: recent.map((m) => ({
            role: m.role,
            content: m.content,
            at: m.created_at,
          })),
        });
      },
    },
  },
});
