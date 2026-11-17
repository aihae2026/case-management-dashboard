// 자원 배분 AI 도우미의 대화(추천 결과)를 화면 이동 사이에 보관한다.
// 추천 대상자의 상담 화면으로 갔다가 돌아와도 결과가 남도록 하는 용도이고, 개인정보가 들어 있어서
// 브라우저 저장소에는 쓰지 않고 메모리에만 둔다(새로고침·로그아웃 때 사라진다).
const cache = new Map<string, unknown[]>();

export function getResourceChat<T>(orgId: string): T[] {
  return (cache.get(orgId) as T[] | undefined) ?? [];
}

export function setResourceChat(orgId: string, messages: unknown[]): void {
  cache.set(orgId, messages);
}

/** orgId 를 주면 그 기관 것만, 안 주면 전부 지운다 */
export function clearResourceChat(orgId?: string): void {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}
