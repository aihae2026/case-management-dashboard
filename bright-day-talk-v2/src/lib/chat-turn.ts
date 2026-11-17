// 채팅 한 번(한 차례)의 상태를 직전 저장 기록으로 판단한다. 서버(chat.ts)에서만 쓴다.
export type RecentRow = { role: string; content: string; created_at: string };

// recent는 최신 메시지가 맨 앞인 최근 기록(몇 건)이다.
// - alreadySaved: 재시도라서 이 사용자 메시지가 이미 저장돼 있다 (중복 저장 금지).
//   저장돼 있지 않으면(첫 요청이 저장 전에 실패한 경우) 재시도여도 저장해야 대화 기록과 모니터링에서 빠지지 않는다.
// - lastMessageAt: 이번 사용자 메시지 "직전"의 대화 시각 (오랜만의 대화 안내에 쓴다)
export function resolveTurnState(
  recent: RecentRow[],
  isRetry: boolean,
  userText: string,
): { alreadySaved: boolean; lastMessageAt: string | undefined } {
  if (isRetry) {
    const idx = recent.findIndex((r) => r.role === "user" && r.content === userText);
    if (idx >= 0) return { alreadySaved: true, lastMessageAt: recent[idx + 1]?.created_at };
  }
  return { alreadySaved: false, lastMessageAt: recent[0]?.created_at };
}
