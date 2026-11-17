// 생년월일 인증 상태 저장/확인 유틸리티
// - keepLoggedIn=false: sessionStorage (탭 닫으면 초기화)
// - keepLoggedIn=true : localStorage 영구 유지 (만료 없음)

const SESSION_KEY = (code: string) => `malbeot_birth_ok_${code}`;
const PERSIST_KEY  = (code: string) => `malbeot_birth_persist_${code}`;
const PERMANENT = "permanent"; // 만료 없는 영구 플래그

export function setBirthVerified(code: string, keepLoggedIn: boolean) {
  try { sessionStorage.setItem(SESSION_KEY(code), "1"); } catch { /* ignore */ }
  if (keepLoggedIn) {
    try {
      // 한 기기에는 한 사람의 "기억"만 남긴다. 여러 개가 남으면 첫 화면 자동 입장이 엉뚱한 사람으로 간다.
      const stale: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("malbeot_birth_persist_") && k !== PERSIST_KEY(code)) stale.push(k);
      }
      stale.forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(PERSIST_KEY(code), PERMANENT);
    } catch { /* ignore */ }
  }
}

export function isBirthVerified(code: string): boolean {
  // 1) localStorage 영구 캐시 확인
  try {
    const val = localStorage.getItem(PERSIST_KEY(code));
    if (val === PERMANENT) return true;           // 영구 플래그
    const exp = Number(val);
    if (exp && Date.now() < exp) return true;     // 기존 30일 타임스탬프 (하위호환)
  } catch { /* ignore */ }
  // 2) sessionStorage 탭 캐시 확인
  try {
    if (sessionStorage.getItem(SESSION_KEY(code)) === "1") return true;
  } catch { /* ignore */ }
  return false;
}

// "로그인 상태 유지"로 이 기기에 저장된 고유번호를 찾는다 (없으면 null).
// 첫 화면에서 다시 입력하지 않고 바로 들어가는 데 쓴다.
export function findRememberedCode(): string | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const m = localStorage.key(i)?.match(/^malbeot_birth_persist_(\d{1,8})$/);
      if (m && isBirthVerified(m[1])) return m[1];
    }
  } catch { /* ignore */ }
  return null;
}

// 인증 화면에서 "뒤로"를 눌러 첫 화면으로 왔을 때 곧바로 다시 자동 입장되지 않도록 한 번만 건너뛴다.
const SKIP_AUTO_KEY = "malbeot_skip_auto_login";
export function skipAutoLoginOnce() {
  try { sessionStorage.setItem(SKIP_AUTO_KEY, "1"); } catch { /* ignore */ }
}
export function consumeSkipAutoLogin(): boolean {
  try {
    const skip = sessionStorage.getItem(SKIP_AUTO_KEY) === "1";
    sessionStorage.removeItem(SKIP_AUTO_KEY);
    return skip;
  } catch {
    return false;
  }
}

// 강제 로그아웃/승인 해제 시 생년월일 캐시 제거
export function clearBirthVerified(code: string) {
  try { sessionStorage.removeItem(SESSION_KEY(code)); } catch { /* ignore */ }
  try { localStorage.removeItem(PERSIST_KEY(code)); } catch { /* ignore */ }
}
