/**
 * 대한민국 공휴일 + 절기 정보
 *
 * - 공휴일: date-holidays (KR) — 설날·추석·부처님오신날·대체공휴일 자동 계산
 * - 삼복: 천간(庚日) 기반 자동 계산 (기준: 2024-06-25 = 庚日)
 * - 정월대보름·단오·동지: 연도별 하드코딩 (SEASONAL_EVENTS, 연간 업데이트 필요)
 */

import Holidays from "date-holidays";

export type DayInfo = {
  holiday?: string;   // 공휴일 이름
  isHoliday?: boolean; // 달력 색상(빨간색) 적용 여부
  season?: string;    // 절기 이름
};

// ── 공휴일 이름 한국어 변환 ───────────────────────────
// date-holidays의 영문 이름 → 한국어 (ko 로케일 미지원 대비)
const HOLIDAY_KO: Record<string, string> = {
  "New Year's Day":              "신정",
  "Independence Movement Day":   "삼일절",
  "Labor Day":                   "근로자의날",
  "Children's Day":              "어린이날",
  "Buddha's Birthday":           "부처님오신날",
  "Memorial Day":                "현충일",
  "Liberation Day":              "광복절",
  "National Foundation Day":     "개천절",
  "Hangul Day":                  "한글날",
  "Christmas Day":               "성탄절",
  "Lunar New Year":              "설날",
  "Chuseok":                     "추석",
  "Substitute holiday":          "대체공휴일",
  "substitute holiday":          "대체공휴일",
};

function toKorean(name: string): string {
  for (const [en, ko] of Object.entries(HOLIDAY_KO)) {
    if (name.toLowerCase().includes(en.toLowerCase())) return ko;
  }
  // date-holidays가 이미 한국어를 반환한 경우 그대로 사용
  return name;
}

// ── date-holidays 인스턴스 ────────────────────────────
const hd = new Holidays("KR");

const holidayCache = new Map<number, Map<string, DayInfo>>();

/**
 * UTC Date → KST "YYYY-MM-DD"
 * date-holidays의 start/end는 UTC 기준 Date 객체이므로 +9h 보정 필요
 */
function toKstDateStr(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

/**
 * 설날 연휴 하드코딩 (출처: 한국천문연구원 역서)
 * date-holidays의 `korean 01-0-01 P3D`는 당일 앵커라 전날이 누락되므로 직접 정의
 * 형식: { prev: 전날, main: 당일, next: 다음날 }
 * 대체공휴일은 date-holidays가 별도 1일 항목으로 올바르게 반환 → 그대로 사용
 */
const SEOLLAL: Record<number, { prev: string; main: string; next: string }> = {
  2024: { prev: "2024-02-09", main: "2024-02-10", next: "2024-02-11" },
  2025: { prev: "2025-01-28", main: "2025-01-29", next: "2025-01-30" },
  2026: { prev: "2026-02-16", main: "2026-02-17", next: "2026-02-18" },
  2027: { prev: "2027-02-06", main: "2027-02-07", next: "2027-02-08" },
  2028: { prev: "2028-01-26", main: "2028-01-27", next: "2028-01-28" },
};

function buildHolidayMap(year: number): Map<string, DayInfo> {
  if (holidayCache.has(year)) return holidayCache.get(year)!;
  const entries = hd.getHolidays(year);
  const map = new Map<string, DayInfo>();

  for (const e of entries) {
    if (e.type !== "public") continue;
    const name = toKorean(e.name);

    // 설날 본 연휴(P3D)는 하드코딩으로 대체 — 전날 누락 + 앵커 오류 방지
    // 단, substitute:true인 대체공휴일(설날 겹침 보상일)은 그대로 처리
    if (name === "설날" && !e.substitute) continue;

    // start~end 범위의 모든 KST 날짜를 순회
    // 추석 P3D: start=전날 앵커 → 전날·당일·다음날 정확
    const kstStartMs = e.start.getTime() + 9 * 60 * 60 * 1000;
    const kstEndMs   = e.end.getTime()   + 9 * 60 * 60 * 1000;

    const startUTC = Date.UTC(
      new Date(kstStartMs).getUTCFullYear(),
      new Date(kstStartMs).getUTCMonth(),
      new Date(kstStartMs).getUTCDate(),
    );
    const endUTC = Date.UTC(
      new Date(kstEndMs).getUTCFullYear(),
      new Date(kstEndMs).getUTCMonth(),
      new Date(kstEndMs).getUTCDate(),
    );

    const ONE_DAY = 86400000;
    const totalDays = Math.round((endUTC - startUTC) / ONE_DAY);
    let cur = startUTC;
    let idx = 0;
    while (cur < endUTC) {
      const ds = new Date(cur).toISOString().slice(0, 10);
      // 이름 표시: 1일짜리 → 항상, 3일 연휴 → 중간(idx=1)이 당일
      const isMainDay = totalDays <= 1 || (totalDays === 3 && idx === 1);
      const prev = map.get(ds);
      if (!prev || name === "대체공휴일") {
        map.set(ds, { holiday: isMainDay ? name : undefined, isHoliday: true });
      }
      cur += ONE_DAY;
      idx++;
    }
  }

  // 설날 연휴 하드코딩 적용
  const sl = SEOLLAL[year];
  if (sl) {
    const slEntries: Array<[string, string | undefined]> = [
      [sl.prev, undefined],   // 전날: 빨간 숫자만
      [sl.main, "설날"],      // 당일: 이름 표시
      [sl.next, undefined],   // 다음날: 빨간 숫자만
    ];
    for (const [ds, holName] of slEntries) {
      const prev = map.get(ds);
      if (!prev) map.set(ds, { holiday: holName, isHoliday: true });
    }
  }

  holidayCache.set(year, map);
  return map;
}

// ── 삼복 자동 계산 ────────────────────────────────────
// 복날 = 하지 후 3번째(초복)·4번째(중복) 庚日, 입추 후 첫 庚日(말복)
// 庚은 천간 10주기 중 7번째 — 10일마다 반복
// 기준일: 2024-06-25 = 庚日 (UTC 정오 기준)
const BASE_GENG_DAY = Math.floor(Date.UTC(2024, 5, 25, 12) / 86400000);

/** date의 UTC 정오 일련번호 */
function toDay(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12) / 86400000);
}

/** from 다음날 이후 가장 가까운 庚日 반환 */
function nextGengAfter(from: Date): Date {
  const base = toDay(from) + 1; // 다음날부터
  const mod = ((base - BASE_GENG_DAY) % 10 + 10) % 10;
  const skip = mod === 0 ? 0 : 10 - mod;
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1 + skip);
}

// 하지·입추 날짜 테이블 (year → [month 0-indexed, day])
// 하지: 대부분 6/21, 입추: 대부분 8/7 — 1-2일 변동 있음
const SOLAR_TERMS: Record<number, { haji: [number, number]; ipchu: [number, number] }> = {
  2024: { haji: [5, 21], ipchu: [7,  7] },
  2025: { haji: [5, 21], ipchu: [7,  7] },
  2026: { haji: [5, 21], ipchu: [7,  7] },
  2027: { haji: [5, 21], ipchu: [7,  7] },
  2028: { haji: [5, 20], ipchu: [7,  7] },
};

function getDogDayMap(year: number): Map<string, string> {
  const result = new Map<string, string>();
  const t = SOLAR_TERMS[year];
  if (!t) return result;

  const haji  = new Date(year, t.haji[0],  t.haji[1]);
  const ipchu = new Date(year, t.ipchu[0], t.ipchu[1]);

  const g1      = nextGengAfter(haji);       // 하지 후 1번째 庚日
  const g2      = nextGengAfter(g1);         // 2번째
  const chobok  = nextGengAfter(g2);         // 3번째 → 초복
  const jungbok = nextGengAfter(chobok);     // 4번째 → 중복
  const malbok  = nextGengAfter(ipchu);      // 입추 후 1번째 → 말복

  const fmt = (d: Date) => d.toLocaleDateString("en-CA");
  result.set(fmt(chobok),  "초복");
  result.set(fmt(jungbok), "중복");
  result.set(fmt(malbok),  "말복");
  return result;
}

// ── 절기 고정 데이터 ─────────────────────────────────
// 음력 기반(정월대보름·단오) + 천문 기반(동지) — 연간 추가 필요
// 출처: 한국천문연구원 역서 기준
const SEASONAL_EVENTS: Array<{ date: string; name: string }> = [
  // 정월대보름 (음력 1/15)
  { date: "2024-02-24", name: "정월대보름" },
  { date: "2025-02-12", name: "정월대보름" },
  { date: "2026-03-03", name: "정월대보름" },
  { date: "2027-02-21", name: "정월대보름" },
  { date: "2028-02-10", name: "정월대보름" },
  // 단오 (음력 5/5)
  { date: "2024-06-10", name: "단오" },
  { date: "2025-05-31", name: "단오" },
  { date: "2026-06-19", name: "단오" },
  { date: "2027-06-09", name: "단오" },
  { date: "2028-06-27", name: "단오" },
  // 동지
  { date: "2024-12-21", name: "동지" },
  { date: "2025-12-22", name: "동지" },
  { date: "2026-12-22", name: "동지" },
  { date: "2027-12-22", name: "동지" },
  { date: "2028-12-21", name: "동지" },
];

// ── 통합 DayInfo 맵 ───────────────────────────────────
const infoCache = new Map<number, Map<string, DayInfo>>();

export function getKoreanDayInfoMap(year: number): Map<string, DayInfo> {
  if (infoCache.has(year)) return infoCache.get(year)!;
  const map = new Map<string, DayInfo>();

  const patch = (dateStr: string, update: Partial<DayInfo>) => {
    map.set(dateStr, { ...map.get(dateStr), ...update });
  };

  // 공휴일 (date-holidays)
  try {
    for (const [d, info] of buildHolidayMap(year)) patch(d, info);
  } catch (e) {
    console.warn("[korean-seasons] date-holidays 공휴일 로딩 실패:", e);
  }

  // 절기 (정월대보름·단오·동지)
  for (const ev of SEASONAL_EVENTS) {
    if (!ev.date.startsWith(String(year))) continue;
    const prev = map.get(ev.date);
    patch(ev.date, { season: prev?.season ? `${prev.season}·${ev.name}` : ev.name });
  }

  // 삼복 (자동 계산)
  for (const [d, name] of getDogDayMap(year)) {
    const prev = map.get(d);
    patch(d, { season: prev?.season ? `${prev.season}·${name}` : name });
  }

  infoCache.set(year, map);
  return map;
}
