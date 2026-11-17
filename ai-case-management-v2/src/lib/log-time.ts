/**
 * 상담기록의 "시간 숨김" 처리.
 * 신규 상담은 날짜는 사용자가 고른 날짜, 시각은 입력한 실제 시각(한국시간)으로 저장하고
 * hide_time=true 로 표시해 화면에는 날짜만 보여 준다. 시각은 같은 날 상담의 순서를 정하는 데만 쓴다.
 * 이전 버전(2026-10-15)이 시간 없는 기록을 한국시간 정오 정각으로 저장했으므로, 그 값도 숨김으로 본다.
 */

const KST_MS = 9 * 60 * 60 * 1000;

/** 날짜(YYYY-MM-DD) + 지금의 한국시간 시각으로 만든 created_at 값 (오늘이면 정확히 지금) */
export function entryIso(date: string, now: Date = new Date()): string {
  const kst = new Date(now.getTime() + KST_MS);
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mm = String(kst.getUTCMinutes()).padStart(2, "0");
  const ss = String(kst.getUTCSeconds()).padStart(2, "0");
  return new Date(`${date}T${hh}:${mm}:${ss}+09:00`).toISOString();
}

/** 한국시간 정오 정각(이전 버전의 "시간 없음" 표시)인지 */
export function isNoonSentinel(iso: string): boolean {
  const kst = new Date(new Date(iso).getTime() + KST_MS);
  return kst.getUTCHours() === 12 && kst.getUTCMinutes() === 0 && kst.getUTCSeconds() === 0 && kst.getUTCMilliseconds() === 0;
}

/** 화면에서 시각을 숨겨야 하는 기록인지 */
export function isTimeHidden(log: { created_at: string; hide_time?: boolean | null }): boolean {
  return !!log.hide_time || isNoonSentinel(log.created_at);
}

/** 상담기록 일시 표시: 숨김이면 날짜만, 아니면 날짜+시각 */
export function formatLogDateTime(log: { created_at: string; hide_time?: boolean | null }): string {
  const d = new Date(log.created_at);
  return isTimeHidden(log) ? d.toLocaleDateString("ko-KR") : d.toLocaleString("ko-KR");
}

/**
 * 저장된 시각(ISO)의 한국시간 날짜(YYYY-MM-DD).
 * created_at.slice(0, 10) 은 UTC 날짜라서 한국시간 00:00~08:59 기록이 전날로 잡히므로 날짜 계산에는 이 함수를 쓴다.
 */
export function toKstDate(iso: string): string {
  return new Date(new Date(iso).getTime() + KST_MS).toISOString().slice(0, 10);
}
