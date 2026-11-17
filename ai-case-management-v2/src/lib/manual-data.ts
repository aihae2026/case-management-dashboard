// 내장 매뉴얼 데이터(비어 있음).
// 기관의 업무 매뉴얼은 내부 문서이므로 코드에 넣지 않는다. 매뉴얼 탭의 [참고자료 추가]에서 PDF·URL·YouTube 를 올리면
// 기관별로 DB 에 저장되어 직원 모두에게 공유된다. 아무 자료도 없으면 매뉴얼 탭이 추가 안내를 보여 준다.
export type ManualChunk = { page: number; text: string };

export const MANUAL_TITLE = "";
export const MANUAL_SUBTITLE = "";
export const MANUAL_PAGES = 0;

export const MANUAL_CHUNKS: ManualChunk[] = [];
