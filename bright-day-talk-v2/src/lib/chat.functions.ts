import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

// 화면에 불러오는 대화 수. 전부 불러오면 1,000건에서 최신 대화가 잘리고,
// 화면의 기록이 매번 AI에 전달되어 비용과 지연도 계속 늘어난다.
const HISTORY_LIMIT = 50;

// Load the elder's recent conversation (latest HISTORY_LIMIT messages) for a device session.
// POST로 보낸다. GET이면 session_id가 요청 주소(쿼리)에 실려 서버 로그와 브라우저 기록에 남는다.
export const getHistory = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ sessionId: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<StoredMessage[]> => {
    // 승인되지 않은 세션에는 대화 기록을 주지 않는다 (DB 장애 시에는 통과)
    const { isSessionApproved } = await import("@/lib/session-guard.server");
    if ((await isSessionApproved(data.sessionId)) === false) return [];

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("session_id", data.sessionId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);

    if (error) {
      console.error("[getHistory] failed:", error.message);
      throw new Error(error.message);
    }
    // 최신순으로 가져왔으니 화면에는 오래된 순으로 돌려준다
    return ((rows ?? []) as StoredMessage[]).reverse();
  });
