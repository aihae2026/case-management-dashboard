/**
 * 기관별 기본 담당자 설정. 코드에 이름을 적어 두지 않고 환경변수 VITE_DEFAULT_WORKER_CONFIG(JSON)로 지정한다.
 * 없으면 빈 설정이라, 담당자 명단은 실제 대상자에 배정된 이름에서 모으고 기본 담당자는 로그인한 사용자가 된다.
 *
 * 예) VITE_DEFAULT_WORKER_CONFIG={"roster":["홍길동","김철수"],"programDefaults":{"무료급식":"김철수","밑반찬":"홍길동"},"sheetKeywords":{"철수":"김철수","길동":"홍길동"}}
 *  - roster: 대상자가 아직 없어도 담당자 필터에 보여 줄 이름
 *  - programDefaults: 사업(프로그램)별 기본 담당자
 *  - sheetKeywords: 엑셀 일괄 등록 시 시트 이름에 이 낱말이 있으면 그 담당자로 등록
 */
type WorkerConfig = {
  roster?: string[];
  programDefaults?: Record<string, string>;
  sheetKeywords?: Record<string, string>;
};

function load(): WorkerConfig {
  try {
    const raw = import.meta.env.VITE_DEFAULT_WORKER_CONFIG as string | undefined;
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as WorkerConfig) : {};
  } catch {
    return {};
  }
}

const config = load();

/** 대상자가 없어도 담당자 필터에 넣을 기본 명단 */
export const DEFAULT_WORKERS: readonly string[] = Array.isArray(config.roster)
  ? config.roster.filter((n): n is string => typeof n === "string" && !!n.trim())
  : [];

/** 이 이름이 환경변수 설정(담당자 명단·사업별 기본 담당자·시트 이름 규칙)에 들어 있는지. 인수인계 뒤 설정을 고쳐야 하는지 안내하는 데 쓴다. */
export function isConfiguredWorker(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  return (
    DEFAULT_WORKERS.includes(n) ||
    Object.values(config.programDefaults ?? {}).some((v) => typeof v === "string" && v.trim() === n) ||
    Object.values(config.sheetKeywords ?? {}).some((v) => typeof v === "string" && v.trim() === n)
  );
}

/** 사업별 기본 담당자(설정이 없으면 null) */
export function programDefaultWorker(program: string): string | null {
  const n = config.programDefaults?.[program];
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

/** 엑셀 시트 이름에서 담당자를 찾는다(설정이 없거나 일치하는 낱말이 없으면 null) */
export function workerFromSheetName(sheetName: string): string | null {
  for (const [keyword, name] of Object.entries(config.sheetKeywords ?? {})) {
    if (keyword && typeof name === "string" && name.trim() && sheetName.includes(keyword)) return name.trim();
  }
  return null;
}
