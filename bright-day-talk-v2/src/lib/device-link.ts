// 이 기기가 어느 어르신의 것인지(등록 연결)를 기억하는 저장 키와, 기기의 세션을 바꾸는 함수.
import { loadProfile, saveProfile } from "@/lib/profile";
import { overrideSessionId, peekSessionId } from "@/lib/session";

export const LINK_KEY = "malbeot_linked";
export const REG_ID_KEY = "malbeot_reg_id";

// 이 기기의 세션을 다른 어르신의 것으로 바꾼다.
// 세션만 바꾸고 이전 사람의 등록 연결·이름·전화를 남겨두면, 새 사람이 이전 사람의 이름으로 불리고
// 승인 해제 감시도 이전 사람의 등록에 걸린다. 그래서 세션이 실제로 바뀔 때만 함께 지운다.
// (같은 사람이 다시 로그인하는 경우에는 아무것도 지우지 않아 바로 채팅이 열린다. 목소리·속도·글씨 설정은 그대로 둔다.)
export function switchSession(nextSessionId: string): void {
  const prev = peekSessionId();
  if (prev && prev !== nextSessionId) {
    try {
      window.localStorage.removeItem(LINK_KEY);
      window.localStorage.removeItem(REG_ID_KEY);
      saveProfile({ ...loadProfile(), seniorName: "", phone: "", orgCode: "" });
    } catch { /* ignore */ }
  }
  overrideSessionId(nextSessionId);
}
