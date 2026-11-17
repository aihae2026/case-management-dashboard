/**
 * AI 로 보내기 전 안내창의 '오늘은 그만 보기' 기억.
 * 사용자별로 한국시간 날짜만 브라우저에 저장하고, 날짜가 바뀌면(자정이 지나면) 다시 안내한다.
 * 저장소를 못 쓰는 환경에서는 매번 안내한다.
 */
import { toKstDate } from "./log-time";

type Store = Pick<Storage, "getItem" | "setItem">;

const key = (uid: string) => `aiNoticeHiddenDate:${uid}`;

/** 한국시간 기준 오늘 날짜(YYYY-MM-DD) */
export function todayKst(now: Date = new Date()): string {
  return toKstDate(now.toISOString());
}

export function isAiNoticeHiddenToday(store: Store | null, uid: string, now: Date = new Date()): boolean {
  try {
    return !!store && store.getItem(key(uid)) === todayKst(now);
  } catch {
    return false;
  }
}

export function hideAiNoticeToday(store: Store | null, uid: string, now: Date = new Date()): void {
  try {
    store?.setItem(key(uid), todayKst(now));
  } catch {
    /* 저장소를 쓸 수 없으면 매번 안내한다 */
  }
}
