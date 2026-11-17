import { supabaseAdmin } from "@/integrations/supabase/client.server";

// 이 기기(session_id)에 승인된 등록이 있는지 서버에서 확인한다.
// true: 승인됨 / false: 승인 안 됨(대기·거절·해제·삭제) / null: 확인 불가(DB 오류)
// 호출하는 쪽은 null이면 통과시켜 DB 장애가 어르신 대화를 막지 않게 한다.
export async function isSessionApproved(sessionId: string): Promise<boolean | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("worker_registrations")
      .select("status")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (error) {
      console.error("[session-guard] 승인 상태 조회 실패:", error.message);
      return null;
    }
    return data?.status === "approved";
  } catch (err) {
    console.error("[session-guard] 승인 상태 확인 중 예외:", err);
    return null;
  }
}
