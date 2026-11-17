import { DEFAULT_WORKERS } from "./worker-defaults";
export type Client = {
  id: string;
  org_id: string;
  name: string;
  birth: string | null;
  phone: string | null;
  type: string;
  grade: string | null;
  worker_name: string | null;
  risk: string;
  needs: string[];
  summary: string | null;
  progress: number;
  note: string | null;
  last_contact_at: string | null;
  last_contact_method: string | null;
  registered_at: string | null;
  rrn_front: string | null;
  rrn_back1: string | null;
  gender: string | null;
  address: string | null;
  address_detail: string | null;
  housing: string | null;
  education: string | null;
  welfare_status: string | null;
  genogram?: string | null;
  consent_drive_id?: string | null;
  consent_drive_url?: string | null;
  ai_consent?: "unset" | "agree" | "refuse" | string | null;
  client_code?: string | null;
  updated_at: string;
};

// 재사정 기록지 주요 내용
export type ReassessFamily = {
  relation: string;
  name: string;
  age: string;
  job: string;
  cohabit: string; // 동거/비동거
  note: string;
};
export type EvalItem = {
  need: string; // 욕구
  goal: string; // 실행목표
  content: string; // 실행 내용
  achievement: string; // 목표 달성도
};
export type PlanItem = {
  problem: string; // 요구/드러난 문제
  need: string; // 욕구
  action: string; // 행동계획
  priority: string; // 우선순위(긴급성)
};

// ── 사례관리 계획서 (재사정 기록지 AI 추출) ─────────────────────────
export type CarePlanAction = {
  id: string;           // 고유 ID
  text: string;         // 원문 (예: "잡곡 지원 2회")
  targetCount?: number; // 목표 횟수 (예: 2)
  unit?: string;        // 단위 (예: "회")
  manualRate?: number;  // 수동 달성률 override (0–100); undefined이면 자동 계산
  manualNote?: string;  // 수동 설정 메모
  // 계획 항목 ↔ 상담기록·제공이력 연결. care_plan_action_links 표에서 읽어 화면용으로 채우는 값이며(care-plan-links.ts),
  // clients.note 에는 더 이상 저장하지 않는다(옛 note 에 남아 있는 값은 읽지 않는다).
  linkedLogIds?: string[];   // 수동으로 연결한 상담기록 ID
  linkedProvIds?: string[];  // 수동으로 연결한 제공이력 ID
  excludedLogIds?: string[]; // 자동 매칭에서 수동 제외한 상담기록 ID
  excludedProvIds?: string[];// 자동 매칭에서 수동 제외한 제공이력 ID
};

export type CarePlanRow = {
  id: string;
  priority: number;
  problem: string;      // 요구/드러난 문제
  need: string;         // 욕구
  selfPlan: CarePlanAction[];   // 당사자 행동계획
  workerPlan: CarePlanAction[]; // 담당자 행동계획
};

export type CarePlan = {
  year: number;         // 계획 연도 (문서 첫 페이지에서 추출)
  rows: CarePlanRow[];
  extractedAt: string;
};
export type ReassessFile = {
  name: string;
  type?: string;
  // Google Drive (신규)
  driveUrl?: string;
  driveId?: string;
  // 추출된 PDF 텍스트를 Drive에 .txt로 저장한 파일 ID (DB에 텍스트 직접 저장 안 함)
  extractedTextDriveId?: string;
  // Supabase Storage (구버전 호환 — 신규 업로드에는 사용하지 않음)
  path?: string;
  // 구버전 호환: 기존 DB에 이미 저장된 텍스트 (읽기 전용, 신규 업로드는 extractedTextDriveId 사용)
  extractedText?: string;
};
export type Reassessment = {
  docType?: "reassessment" | "intake"; // 문서 유형: 재사정 | 적격심사지(초기 사정)
  reassessedAt?: string; // 일시(문서상 재사정 실시일 기준)
  uploadedAt?: string; // 파일을 업로드한 날짜(참고용)
  yearNo?: string; // 년차
  method?: string; // 방법 (내방/방문/전화)
  worker?: string; // 담당 사회복지사
  personal?: {
    religion?: string;
    protection?: string; // 보호구분
    disability?: string; // 장애종류/급
    education?: string;
    household?: string; // 가족구성
    longTermCare?: string; // 장기요양보험 등급
    emergencyContact?: string; // 비상연락처
    emergencyRelation?: string; // 관계
  };
  family?: ReassessFamily[]; // 가족사항
  reassessType?: string; // 재사정 유형
  reassessFactor?: string; // 재사정 요인
  changes?: {
    physical?: string; // 신체적
    psychological?: string; // 심리적
    economic?: string; // 경제적
    social?: string; // 사회적 관계망
    etc?: string; // 기타
  };
  // 척도
  scales?: {
    sgdsTotal?: string; // 우울척도 총점
    sgdsResult?: string; // 우울척도 판정
    sgdsOpinion?: string; // 우울척도 의견
    mspssAgency?: string; // 사회지지-복지관
    mspssFriend?: string; // 사회지지-친구
    mspssOther?: string; // 사회지지-주변인
    mspssOpinion?: string; // 사회지지 의견
    sgds?: string; // (구버전 호환)
    mspss?: string; // (구버전 호환)
  };
  evaluation?: {
    // 사례관리 평가서
    items?: EvalItem[];
    clientReview?: string; // 총평(클라이언트)
    workerReview?: string; // 총평(사회복지사)
    result?: string; // 재사정/의뢰/종결
  };
  plan?: PlanItem[]; // 사례관리 계획서
  contract?: {
    // 서비스 계약서
    period?: string; // 서비스 제공 기간
    services?: string; // 서비스 종류
    note?: string; // 비고
  };
  files?: ReassessFile[]; // 첨부 자료 (이미지/PDF 등)
  workerOpinion?: string; // 사회복지사 의견
  result?: string; // 재사정 결과
  aiAnalysis?: ReassessAiAnalysis; // AI 추천 분석(담당자 수정·확정)
  carePlan?: CarePlan; // 사례관리 계획서 (AI 추출)
};

// 재사정 AI 추천 분석 (담당자가 수정·확정). needs는 서비스 목표 연계용.
export type ReassessNeed = {
  problem: string;
  need: string;
  goal: string;
  clientAction: string;
  workerAction: string;
  priority: string;
  urgency: string;
  checkCycle: string;
  criteria: string;
};
export type ReassessAiAnalysis = {
  areaChanges?: string; // 하위호환 (구버전 기록)
  physicalChanges?: string;
  psychologicalChanges?: string;
  economicChanges?: string;
  socialChanges?: string;
  etcChanges?: string;
  expressedNeeds?: string;
  identifiedNeeds?: string;
  problems?: string;
  risks?: string;
  strengths?: string;
  interventionAreas?: string;
  recommendedGoals?: string;
  recommendedActions?: string;
  priorities?: string;
  needs?: ReassessNeed[];
  at?: string; // 분석/확정 시각
  confirmed?: boolean; // 담당자 확정 여부
};

// 재사정 데이터는 기존 clients.note 컬럼에 안전하게 함께 저장한다(별도 컬럼 마이그레이션이 반영되지 않는 환경 대응).
// 사람이 쓰는 비고와 재사정 JSON을 아래 구분자로 나눠 보관하고, 화면에는 비고만 보여준다.
const REASSESS_SEP = "\n␞재사정␞\n"; // 사용자가 입력할 일 없는 구분자

// 서비스 목표 달성도 AI 분석 결과 (지속 저장용)
export type GoalAnalysis = { text: string; at: string };

// ── 밑반찬 실태조사 ─────────────────────────────────────────────────
export type SideDishAssessmentFile = {
  name: string;
  driveUrl?: string;
  driveId?: string;
};

/** 밑반찬 실태조사 1회차 기록 */
export type SideDishAssessment = {
  id: string;               // 고유 ID (nanoid 등)
  assessedAt: string;       // 조사일 YYYY-MM-DD
  livingCondition: string;  // 생활 실태
  healthCondition: string;  // 건강 실태
  mealCondition: string;    // 급식 실태
  specialNotes: string;     // 특이사항
  workerOpinion: string;    // 사회복지사 의견
  selectionContent: string; // 선정조사표 내용 (선정 사유 등)
  selectionResult: string;  // 선정 결과 (선정/미선정/보류)
  meetingContent: string;   // 사례회의록 내용
  meetingDecision: string;  // 결정사항
  files?: SideDishAssessmentFile[];
  uploadedAt?: string;
};

// ── 무료급식 종합의견 ────────────────────────────────────────────────
/** 무료급식 종합의견 1회 기록 (SideDishAssessment와 동일 구조) */
export type MealOpinionRecord = {
  id: string;
  recordedAt: string;        // 기록일 YYYY-MM-DD
  livingCondition: string;   // 생활 실태
  healthCondition: string;   // 건강 실태
  mealCondition: string;     // 급식 실태 (결식 사유, 급식 현황)
  specialNotes: string;      // 특이사항
  workerOpinion: string;     // 사회복지사 종합의견
  selectionContent?: string; // 선정 내용 (신청 경위, 선발 사유 등)
  driveUrl?: string;         // Google Drive PDF URL
  driveId?: string;
  fileName?: string;
  uploadedAt?: string;
};
/** 하위 호환용 — 구버전 단일 객체 형식도 수용 */
export type MealOpinion = MealOpinionRecord | null;

/** 가족관계 항목 */
export type FamilyMember = {
  id: string;        // 고유 식별자 (uuid 짧은 버전)
  name: string;      // 성명
  relation: string;  // 관계 (배우자, 딸, 아들, 자녀 등)
  birth: string;     // 생년월일
  occupation: string;// 직업
  phone: string;     // 연락처
  cohabit?: string;  // 동거 여부 ("동거" | "비동거" | "")
  memo?: string;     // 비고
};

/** note 원문 → { 비고, 재사정 이력, 목표분석, 종결사유, 밑반찬 실태조사, 무료급식 종합의견, 가족관계 } 분리. 구버전(배열/단일)도 변환. */
export function splitNote(raw: string | null): {
  note: string;
  reassessments: Reassessment[];
  goalAnalysis: GoalAnalysis | null;
  closeReason: string | null;
  sideDishAssessments: SideDishAssessment[];
  mealOpinion: MealOpinionRecord[];
  familyMembers: FamilyMember[];
} {
  const s = raw ?? "";
  const i = s.indexOf(REASSESS_SEP);
  if (i < 0) return { note: s, reassessments: [], goalAnalysis: null, closeReason: null, sideDishAssessments: [], mealOpinion: [], familyMembers: [] };
  const human = s.slice(0, i);
  try {
    const parsed = JSON.parse(s.slice(i + REASSESS_SEP.length));
    // 구버전: 재사정 배열(또는 단일 객체)만 저장
    if (Array.isArray(parsed))
      return { note: human, reassessments: parsed as Reassessment[], goalAnalysis: null, closeReason: null, sideDishAssessments: [], mealOpinion: [], familyMembers: [] };
    if (parsed && !parsed.r && !parsed.ga)
      return { note: human, reassessments: [parsed as Reassessment], goalAnalysis: null, closeReason: null, sideDishAssessments: [], mealOpinion: [], familyMembers: [] };
    // 신버전: { r: 재사정[], ga: 목표분석, cr: 종결사유, sd: 밑반찬 실태조사[], mo: 무료급식 종합의견[] }
    // mo가 구버전 단일 객체(id 없음)면 빈 배열로 무시
    const rawMo = parsed?.mo;
    const mealOpinion: MealOpinionRecord[] = Array.isArray(rawMo)
      ? (rawMo as MealOpinionRecord[])
      : [];
    return {
      note: human,
      reassessments: (parsed?.r ?? []) as Reassessment[],
      goalAnalysis: (parsed?.ga ?? null) as GoalAnalysis | null,
      closeReason: (parsed?.cr ?? null) as string | null,
      sideDishAssessments: (parsed?.sd ?? []) as SideDishAssessment[],
      mealOpinion,
      familyMembers: (parsed?.fm ?? []) as FamilyMember[],
    };
  } catch (e) {
    console.error("[splitNote] JSON 파싱 실패 — note 손상 의심:", e, raw?.slice(0, 200));
    return { note: human, reassessments: [], goalAnalysis: null, closeReason: null, sideDishAssessments: [], mealOpinion: [], familyMembers: [] };
  }
}

// ── 계획 항목 연동용 헬퍼 ────────────────────────────────────────────
/** 계획 항목 연동 다이얼로그용: reassessedAt, rowId, role, action을 묶어 반환 */
export type ActiveAction = {
  reassessedAt: string;
  rowId: string;
  area: string;    // 욕구 또는 문제 (표시용)
  role: "self" | "worker";
  action: CarePlanAction;
  planYear: number; // 이 항목이 속한 계획서 연도 (care_plan_action_links.plan_year)
};

/** 대상자의 가장 최근 carePlan에서 모든 행동계획 항목을 가져온다.
 *  1차: 현재 연도(year)의 carePlan을 탐색.
 *  2차: 해당 연도 carePlan이 없으면 가장 최근 carePlan(연도 무관)으로 폴백. */
export function getActiveCarePlanActions(client: { note: string | null }, year?: number): ActiveAction[] {
  const { reassessments } = splitNote(client.note);
  const targetYear = year ?? new Date().getFullYear();

  function buildActions(r: Reassessment): ActiveAction[] {
    if (!r.carePlan || r.carePlan.rows.length === 0) return [];
    const result: ActiveAction[] = [];
    const planYear = Number(r.carePlan.year);
    for (const row of r.carePlan.rows) {
      const area = row.need || row.problem || "미분류";
      for (const action of row.selfPlan ?? []) {
        result.push({ reassessedAt: r.reassessedAt ?? "", rowId: row.id, area, role: "self", action, planYear });
      }
      for (const action of row.workerPlan ?? []) {
        result.push({ reassessedAt: r.reassessedAt ?? "", rowId: row.id, area, role: "worker", action, planYear });
      }
    }
    return result;
  }

  // 1차: 현재 연도 매칭 — 뒤에서부터 탐색 (가장 최근 기록 우선)
  for (let i = reassessments.length - 1; i >= 0; i--) {
    const r = reassessments[i];
    if (!r.carePlan || r.carePlan.rows.length === 0) continue;
    if (Number(r.carePlan.year) !== targetYear) continue;
    const result = buildActions(r);
    if (result.length > 0) return result;
  }

  // 2차 폴백: 연도 무관 — 행동계획이 있는 가장 최근 carePlan
  for (let i = reassessments.length - 1; i >= 0; i--) {
    const r = reassessments[i];
    const result = buildActions(r);
    if (result.length > 0) return result;
  }

  return [];
}

/** 비고 + 재사정 이력 + 목표분석 + 종결사유 + 밑반찬 실태조사 + 무료급식 종합의견 + 가족관계 → note 원문으로 합치기 */
export function joinNote(
  note: string,
  reassessments: Reassessment[],
  goalAnalysis: GoalAnalysis | null = null,
  closeReason: string | null = null,
  sideDishAssessments: SideDishAssessment[] = [],
  mealOpinion: MealOpinionRecord[] = [],
  familyMembers: FamilyMember[] = [],
): string {
  const human = note ?? "";
  const hasSd = sideDishAssessments && sideDishAssessments.length > 0;
  const hasMo = mealOpinion && mealOpinion.length > 0;
  const hasFm = familyMembers && familyMembers.length > 0;
  const has = (reassessments && reassessments.length > 0) || goalAnalysis || closeReason || hasSd || hasMo || hasFm;
  if (!has) return human;
  const payload: Record<string, unknown> = { r: reassessments ?? [], ga: goalAnalysis };
  if (closeReason) payload.cr = closeReason;
  if (hasSd) payload.sd = sideDishAssessments;
  if (hasMo) payload.mo = mealOpinion;
  if (hasFm) payload.fm = familyMembers;
  return human + REASSESS_SEP + JSON.stringify(payload);
}

export type ActivityLog = {
  id: string;
  client_id: string;
  org_id: string;
  method: string;
  title: string | null;
  note: string;
  result: string | null;
  worker_name: string | null;
  created_at: string;
  transcript: string | null;
  audio_url: string | null;
  /** true 이면 화면에서 시각을 숨기고 날짜만 보여 준다(신규 상담) */
  hide_time?: boolean | null;
};

export type Provision = {
  id: string;
  client_id: string;
  org_id: string;
  category: string;
  title: string;
  quantity: string | null;
  agency: string | null;
  note: string | null;
  provided_at: string;
};

export type Goal = {
  id: string;
  org_id: string;
  client_id: string;
  kind: string;
  title: string;
  detail: string | null;
  progress: number;
  source: string;
  created_at: string;
  updated_at: string;
};

export type OrgRow = {
  id: string;
  name: string;
  org_type: string;
  client_types: string[];
  join_code?: string | null;
  slug?: string | null;
};

export type ProfileRow = { id: string; name: string; org_id: string | null; status?: string };

export const RISK_LEVELS = ["정상", "주의", "경고", "고위험"] as const;
export const CONTACT_METHODS = ["전화", "방문", "문자", "내방"] as const;

// 사례관리 구분 (grade 컬럼을 재사용해 저장). 매뉴얼의 사정수준(위기/집중/일반)을 현장 표현인 중점/일반으로 단순화.
export const CARE_LEVELS = ["중점", "일반"] as const;
export type CareLevel = (typeof CARE_LEVELS)[number];

// 종결 사유
export const CLOSE_REASONS = ["이사", "사망", "본인의사", "직접입력"] as const;
export type CloseReasonPreset = (typeof CLOSE_REASONS)[number];

/** grade === "종결"인 대상자 여부 */
export function isTerminated(client: { grade: string | null }): boolean {
  return client.grade === "종결";
}

/** 종결 배지 모양(중점/일반 배지 자리에 대신 표시) */
export const terminatedStyle = "bg-zinc-100 text-zinc-700 border-zinc-300 font-medium";

export const careLevelStyle: Record<string, string> = {
  중점: "bg-red-50 text-red-700 border-red-200",
  일반: "bg-slate-50 text-slate-700 border-slate-200",
};

/** grade 컬럼 값을 사례관리 구분(중점/일반)으로 정규화한다. 과거 데이터(집중관리/위기 등)도 중점으로 매핑. */
export function careLevelOf(client: { grade: string | null }): CareLevel {
  const g = client.grade ?? "";
  if (g.includes("중점") || g.includes("집중") || g.includes("위기") || g.includes("전문"))
    return "중점";
  return "일반";
}

// ── 사업 구분(프로그램) ─────────────────────────────
// 한 대상자가 여러 사업에 동시 소속 가능. type 컬럼에 콤마로 저장(예: "사례관리,밑반찬").
// 마이그레이션 없이 기존 type 컬럼을 재사용하며, 과거 값("노인" 등)은 사례관리로 간주한다.
export const PROGRAMS = ["사례관리", "밑반찬", "무료급식"] as const;
export type Program = (typeof PROGRAMS)[number];
const PROGRAM_SET = new Set<string>(PROGRAMS);

export const programStyle: Record<string, string> = {
  사례관리: "bg-indigo-50 text-indigo-700 border-indigo-200",
  밑반찬: "bg-amber-50 text-amber-700 border-amber-200",
  무료급식: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

/** 대상자가 속한 사업 목록. 알 수 없는/과거 값은 사례관리로 간주. */
export function programsOf(client: { type: string | null }): string[] {
  const raw = (client.type ?? "")
    .split(/[,·/]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const known = raw.filter((p) => PROGRAM_SET.has(p));
  return known.length ? Array.from(new Set(known)) : ["사례관리"];
}

/** 선택한 사업 목록을 type 컬럼 문자열로 변환(빈 값이면 사례관리). */
export function programsToType(programs: string[]): string {
  const uniq = Array.from(new Set(programs.filter((p) => PROGRAM_SET.has(p))));
  return (uniq.length ? uniq : ["사례관리"]).join(",");
}

/** 중점/일반 구분은 사례관리 대상자에게만 의미가 있다. */
export function hasCareLevel(client: { type: string | null }): boolean {
  return programsOf(client).includes("사례관리");
}

/** 사업·중점/일반·담당자 필터에 대상자가 부합하는지. care는 사례관리 대상자에만 적용. 종결 대상자는 항상 제외. */
export function matchesScope(
  c: { type: string | null; grade: string | null; worker_name: string | null },
  program: string,
  care: "전체" | "중점" | "일반",
  worker: string,
): boolean {
  if (isTerminated(c)) return false; // 종결 대상자는 모든 분석·필터에서 제외
  if (program !== "전체" && !programsOf(c).includes(program)) return false;
  if (care !== "전체") {
    if (!programsOf(c).includes("사례관리")) return false;
    if (careLevelOf(c) !== care) return false;
  }
  if (worker !== "전체" && (c.worker_name ?? "") !== worker) return false;
  return true;
}

// 기본 담당자 명단은 환경변수(VITE_DEFAULT_WORKER_CONFIG)로 지정한다 — worker-defaults.ts 참고.
// 실제 배정된 담당자는 대상자 데이터에서 자동 수집된다.

/** 담당자 필터용 명단: 기본 담당자 + 실제 대상자에 배정된 이름을 합쳐 반환. */
export function workerRoster(clients: { worker_name: string | null }[]): string[] {
  const set = new Set<string>(DEFAULT_WORKERS);
  clients.forEach((c) => {
    const n = c.worker_name?.trim();
    if (n) set.add(n);
  });
  return [...set];
}

// 욕구 항목별 매칭 키워드 (상담기록 노트에서 자동 감지용)
export const NEED_KEYWORDS: Record<string, string[]> = {
  "생계비":        ["생계비","생활비","식비","식료품","경제적"],
  "주거비":        ["주거비","월세","임대","전세","주거"],
  "의료비":        ["의료비","병원비","치료비","약값"],
  "공과금":        ["공과금","전기세","수도세","가스비","난방비"],
  "긴급지원":      ["긴급지원","긴급","위기"],
  "만성질환":      ["만성질환","당뇨","고혈압","관절염","심장","고지혈"],
  "거동불편":      ["거동","보행불편","이동제한","휠체어","보조기"],
  "치매":          ["치매","인지저하","기억력","인지증"],
  "결식·영양":     ["결식","끼니","영양","도시락","밑반찬","반찬"],
  "장기요양":      ["장기요양","요양","간병"],
  "정신건강":      ["정신건강","심리","스트레스","정신과"],
  "우울":          ["우울","무기력","우울감"],
  "자살위험":      ["자살","죽고","사라지","극단"],
  "고립·외로움":   ["고립","외로움","외롭","방치","혼자서"],
  "불안":          ["불안","걱정","두려움"],
  "독거":          ["독거","혼자","홀로"],
  "가족갈등":      ["가족갈등","자녀갈등","부부갈등","갈등"],
  "돌봄부재":      ["돌봄부재","보호자","간병인","요양보호사"],
  "사회활동 부족": ["사회활동","프로그램 참여","외부활동"],
  "안전":          ["낙상","안전","사고"],
};

// 대상자 등록을 빠르게: 욕구 키워드를 클릭으로 추가 (매뉴얼 사정 영역: 경제/건강/심리·정서/사회).
export const NEED_PRESETS: Record<string, string[]> = {
  경제: ["생계비", "주거비", "의료비", "공과금", "긴급지원"],
  건강: ["만성질환", "거동불편", "치매", "결식·영양", "장기요양", "정신건강"],
  "심리·정서": ["우울", "자살위험", "고립·외로움", "불안"],
  사회: ["독거", "가족갈등", "돌봄부재", "사회활동 부족", "안전"],
};

// 가구유형·의뢰경로·행정동: 스크리닝 양식 기준 (needs/note로 저장되므로 선택 편의용 목록).
export const HOUSEHOLD_TYPES = ["독거", "부부", "가족", "조손", "기타"];
export const REFERRAL_PATHS = ["본인", "가족", "타 기관 의뢰", "발굴(아웃리치)", "기타"];
export const PROVISION_CATEGORIES = [
  "현물지원",
  "현금지원",
  "프로그램 연계",
  "기타서비스",
] as const;
export const HOUSING_TYPES = ["자가", "전세", "월세", "임대", "무상거주", "시설거주", "기타"];
export const EDUCATION_TYPES = [
  "무학",
  "초등학교",
  "중학교",
  "고등학교",
  "대학교",
  "대학원",
  "기타",
];
export const GENDER_TYPES = ["남", "여"];
export const WELFARE_STATUS = ["일반", "수급자", "차상위", "긴급지원"];

export const riskStyle: Record<string, string> = {
  정상: "bg-emerald-50 text-emerald-700 border-emerald-200",
  주의: "bg-amber-50 text-amber-700 border-amber-200",
  경고: "bg-orange-50 text-orange-700 border-orange-200",
  고위험: "bg-red-50 text-red-700 border-red-200",
};
/** 분류별 항목 빠른선택 프리셋 */
export const PROVISION_PRESETS: Record<string, string[]> = {
  현물지원: ["쌀", "밑반찬", "라면/즉석식품", "식품 세트", "생필품", "위생용품", "의류", "침구류", "의약품", "가전제품"],
  현금지원: ["긴급복지비", "의료비", "주거비", "공과금", "교통비", "식품권"],
  "프로그램 연계": ["방문요양", "주간보호", "식사 배달", "의료 연계", "법률 지원", "문화 프로그램", "일자리 연계"],
  기타서비스: ["이미용", "청소", "세탁", "말벗 서비스", "외출 동행", "주거 환경 개선"],
};

export const categoryColor: Record<string, string> = {
  현물지원: "bg-teal-50 text-teal-700 border-teal-200",
  현금지원: "bg-rose-50 text-rose-700 border-rose-200",
  "프로그램 연계": "bg-purple-50 text-purple-700 border-purple-200",
  기타서비스: "bg-slate-50 text-slate-700 border-slate-200",
};

export function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(diff / 86400000));
}
