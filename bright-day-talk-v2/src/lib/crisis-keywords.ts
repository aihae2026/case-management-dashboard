// 위기 신호로 보는 말 목록. 두 곳에서 같이 쓴다.
// - 담당자용 대화 분석(api/public/companion/analysis.ts): 모든 단계를 위기 신호로 센다.
// - 어르신 화면(ChatWindow): AI 응답이 실패하거나 비었을 때, 마지막 말씀이 "마음의 위기"나 "몸의 위기"이면
//   일반 오류 문구 대신 119·1393 안내를 보여 준다. 부드러운 표현(SOFT)은 안내문을 띄우지 않는다.

// 마음의 위기: 스스로 목숨을 끊겠다는 뜻으로 읽히는 말
export const MIND_CRISIS = [
  "자살", "죽고 싶", "죽고싶", "죽어버리", "목숨", "살기 싫", "살기싫",
  "사라지고 싶", "사라지고싶", "끝내고 싶", "끝내고싶",
] as const;

// 몸의 위기: 지금 몸이 위급하다는 뜻으로 읽히는 말
// ("아프다"는 "아파요"처럼 모양이 바뀌어서 두 가지 모두 넣는다)
export const BODY_CRISIS = [
  "응급", "쓰러", "넘어졌", "넘어져", "숨이", "가슴이 아프", "가슴이 아파", "가슴이 답답",
  "심장이", "많이 아프", "많이 아파",
] as const;

// 부드러운 표현: 분석에서만 센다
export const SOFT_CRISIS = ["무섭", "너무 외로", "혼자 못"] as const;

// 담당자용 분석에서 쓰는 전체 목록
export const ANALYSIS_CRISIS_KEYWORDS: readonly string[] = [
  ...MIND_CRISIS,
  ...BODY_CRISIS,
  ...SOFT_CRISIS,
];

export type CrisisKind = "mind" | "body";

// 띄어쓰기를 지우고 비교해서 "죽고 싶다"와 "죽고싶다"를 모두 잡는다.
const squash = (s: string) => s.replace(/\s+/g, "");

// 어르신 말씀에서 위기 종류를 가린다. 마음의 위기가 몸의 위기보다 먼저다. 해당 없으면 null.
export function classifyCrisis(text: string): CrisisKind | null {
  const t = squash(text);
  if (!t) return null;
  if (MIND_CRISIS.some((k) => t.includes(squash(k)))) return "mind";
  if (BODY_CRISIS.some((k) => t.includes(squash(k)))) return "body";
  return null;
}

// AI가 답하지 못했을 때 화면에 고정으로 보여 주는 안내문
export const CRISIS_NOTICE: Record<CrisisKind, string> = {
  mind:
    "많이 힘드시지요. 지금 연결이 잠시 불안정해요. 마음이 많이 힘드실 때는 자살예방상담전화 1393(24시간)에 전화해 주세요.",
  body:
    "지금 연결이 잠시 불안정해요. 몸이 많이 불편하시거나 위급하시면 바로 119에 전화해 주세요.",
};
