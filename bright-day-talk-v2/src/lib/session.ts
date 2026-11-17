// Client-side helper: a stable per-device session id so the elder never has to
// log in. Conversations are stored in the cloud under this id and can later be
// linked to the social-worker monitoring system.
const KEY = "malbeot_session_id";

export function getSessionId(): string {
  if (typeof window === "undefined") return "";
  let id = window.localStorage.getItem(KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(KEY, id);
  }
  return id;
}

// 새로 만들지 않고 저장된 session_id만 읽는다 (없으면 null).
export function peekSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

// 다른 기기에서 재승인 시 기존 대화가 이어지도록 canonical session_id를 덮어씁니다.
export function overrideSessionId(id: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, id);
}
