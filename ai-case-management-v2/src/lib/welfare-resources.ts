// 복지 자원·사례관리 매뉴얼 근거 카탈로그 (AI 추천 그라운딩용)
//
// ⚠️ 중요: AI 자원 추천은 반드시 이 목록 "안에서만" 매칭하도록 설계되어 있습니다.
// 모델이 목록에 없는 자원/제도를 지어내지 못하게 하는 근거(grounding) 데이터입니다.
// 실제 연계 전에는 각 자원의 최신 대상·기준을 담당자가 반드시 확인해야 합니다.
//
// 유지보수: 기관 실정에 맞는 지역 자원을 여기에 추가하면 AI 추천 범위가 넓어집니다.

export type WelfareResource = {
  id: string;
  category: string; // 자원 유형
  name: string; // 자원/제도명
  target: string; // 대상 (누구에게)
  agency: string; // 연계 기관/신청처
  basis: string; // 근거 법령·지침
};

export const WELFARE_RESOURCES: WelfareResource[] = [
  // 소득 지원
  {
    id: "basic-pension",
    category: "소득지원",
    name: "기초연금",
    target: "만 65세 이상 · 소득인정액 하위 70%",
    agency: "행정복지센터 · 국민연금공단",
    basis: "기초연금법",
  },
  {
    id: "livelihood-benefit",
    category: "소득지원",
    name: "국민기초생활보장 생계급여",
    target: "소득인정액이 생계급여 선정기준 이하인 가구",
    agency: "행정복지센터",
    basis: "국민기초생활 보장법",
  },
  {
    id: "emergency-support",
    category: "소득지원",
    name: "긴급복지지원(생계·의료)",
    target: "주소득자 사망·질병 등 위기사유로 생계가 곤란한 가구",
    agency: "행정복지센터 · 보건복지상담센터(129)",
    basis: "긴급복지지원법",
  },
  // 주거
  {
    id: "housing-benefit",
    category: "주거지원",
    name: "주거급여",
    target: "소득인정액이 주거급여 선정기준 이하인 임차·자가 가구",
    agency: "행정복지센터 · LH",
    basis: "주거급여법",
  },
  {
    id: "housing-repair",
    category: "주거지원",
    name: "노인 주거환경 개선(집수리)",
    target: "주거 안전이 취약한 저소득 노인 가구",
    agency: "지자체 · 지역 자활센터/후원기관",
    basis: "지자체 노인복지사업 지침",
  },
  // 의료·건강
  {
    id: "medical-benefit",
    category: "의료지원",
    name: "의료급여",
    target: "기초생활수급자 등 의료급여 대상자",
    agency: "행정복지센터",
    basis: "의료급여법",
  },
  {
    id: "long-term-care",
    category: "돌봄지원",
    name: "노인장기요양보험(방문요양·주야간보호 등)",
    target: "만 65세 이상 또는 노인성 질병이 있는 자 중 장기요양 등급 인정자",
    agency: "국민건강보험공단",
    basis: "노인장기요양보험법",
  },
  {
    id: "visiting-health",
    category: "의료지원",
    name: "방문건강관리 서비스",
    target: "건강관리가 필요한 취약계층(만성질환·거동불편 등)",
    agency: "보건소",
    basis: "지역보건법 · 방문건강관리 사업지침",
  },
  // 돌봄·안전
  {
    id: "customized-care",
    category: "돌봄지원",
    name: "노인맞춤돌봄서비스",
    target: "일상생활 도움이 필요한 취약 노인(안전확인·가사·사회참여 등)",
    agency: "행정복지센터 · 수행기관",
    basis: "노인맞춤돌봄서비스 사업안내",
  },
  {
    id: "emergency-safety",
    category: "안전지원",
    name: "독거노인·장애인 응급안전안심서비스",
    target: "홀로 사는 노인 등 응급상황 대응이 어려운 대상",
    agency: "행정복지센터 · 지역센터",
    basis: "노인복지법 · 응급안전안심서비스 사업지침",
  },
  {
    id: "elder-protection",
    category: "안전지원",
    name: "노인보호전문기관(학대 대응)",
    target: "노인학대 의심·발생 사례",
    agency: "노인보호전문기관(1577-1389)",
    basis: "노인복지법(노인학대 신고의무)",
  },
  // 식사
  {
    id: "meal-service",
    category: "식사지원",
    name: "경로식당·도시락 배달(식사 지원)",
    target: "결식 우려가 있는 저소득 노인",
    agency: "지역 복지관 · 지자체",
    basis: "노인복지법 · 지자체 급식지원 지침",
  },
  // 사회참여·정서
  {
    id: "senior-job",
    category: "사회참여",
    name: "노인일자리 및 사회활동 지원",
    target: "만 65세 이상(일부 만 60세 이상) 활동 가능 노인",
    agency: "시니어클럽 · 노인복지관 · 지자체",
    basis: "노인일자리 및 사회활동 지원사업 지침",
  },
  {
    id: "mental-health",
    category: "정서지원",
    name: "정신건강복지센터(우울·자살예방 상담)",
    target: "우울·고립·자살 위험이 있는 대상",
    agency: "정신건강복지센터 · 자살예방센터(109)",
    basis: "정신건강복지법",
  },
  {
    id: "social-relation",
    category: "정서지원",
    name: "독거노인 사회관계 활성화 프로그램",
    target: "사회적 고립·단절 위험이 있는 홀로 사는 노인",
    agency: "노인복지관 · 수행기관",
    basis: "지자체 노인복지사업 지침",
  },
];

/** 프롬프트에 넣을 간결한 카탈로그 문자열 (id 기준 매칭용). */
export function resourceCatalogForPrompt(): string {
  return WELFARE_RESOURCES.map(
    (r) => `- id:${r.id} | ${r.category} | ${r.name} | 대상:${r.target}`,
  ).join("\n");
}

export function resourceById(id: string): WelfareResource | undefined {
  return WELFARE_RESOURCES.find((r) => r.id === id);
}
