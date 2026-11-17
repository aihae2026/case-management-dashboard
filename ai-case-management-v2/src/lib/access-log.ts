import { supabase } from "@/integrations/supabase/client";

/**
 * 접속 기록(access_log).
 * - 접속할 때마다 1회: 탭을 새로 열거나 다시 로그인하면 기록하고, 같은 탭에서 새로고침은 기록하지 않는다.
 * - 로그아웃도 기록한다. 세션 만료나 탭 닫기는 기록되지 않는다.
 * - 기록은 화면을 기다리게 하지 않고, 실패해도 업무 화면은 그대로 동작한다.
 */

export type IpFetcher = () => Promise<{ ip: string | null }>;

type AccessBase = {
  org_id: string;
  user_id: string;
  user_name: string | null;
  action: string;
  device: string;
};

const KEY_PREFIX = "accessLogged:";
const IP_KEY = "accessIp"; // 이 탭의 접속 IP(탭을 닫으면 사라짐). 로그아웃·열람 기록에 다시 쓰려고 둔다
const inflight = new Set<string>();
let cachedIp: string | null = null;
let ipInflight: Promise<string | null> | null = null;

export function detectDevice(): string {
  return /Mobi|Android/i.test(navigator.userAgent) ? "모바일" : "PC";
}

function readStoredIp(): string | null {
  try {
    return sessionStorage.getItem(IP_KEY);
  } catch {
    return null;
  }
}

function rememberIp(ip: string | null) {
  if (!ip) return;
  cachedIp = ip;
  try {
    sessionStorage.setItem(IP_KEY, ip);
  } catch { /* 저장소를 못 쓰면 메모리에만 둔다 */ }
}

/** 이 탭의 접속 IP. 메모리 → 탭 저장소 → 서버 순으로 찾고, 3초 안에 못 찾으면 null. */
export async function resolveIp(getIp: IpFetcher): Promise<string | null> {
  if (cachedIp) return cachedIp;
  const stored = readStoredIp();
  if (stored) {
    cachedIp = stored;
    return stored;
  }
  if (!ipInflight) {
    ipInflight = withTimeout(getIp(), 3000)
      .then((r) => {
        rememberIp(r?.ip ?? null);
        return r?.ip ?? null;
      })
      .finally(() => {
        ipInflight = null;
      });
  }
  return ipInflight;
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(null); },
    );
  });
}

/** 한 줄 기록. IP 칸이 아직 DB에 없으면(PGRST204·42703) IP 없이 다시 시도해서 접속 기록 자체는 남긴다. */
async function insertRow(base: AccessBase, ip: string | null): Promise<boolean> {
  const row: AccessBase & { ip?: string | null } = { ...base, ...(ip ? { ip } : {}) };
  const first = await supabase.from("access_log").insert(row);
  if (!first.error) return true;
  const code = first.error.code;
  if (ip && (code === "PGRST204" || code === "42703")) {
    const retry = await supabase.from("access_log").insert(base);
    if (!retry.error) return true;
    console.warn("[access_log] 접속 기록 실패:", retry.error.message, retry.error.code);
    return false;
  }
  console.warn("[access_log] 접속 기록 실패:", first.error.message, code);
  return false;
}

function clearVisitKeys() {
  cachedIp = null;
  try {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith(KEY_PREFIX))
      .forEach((k) => sessionStorage.removeItem(k));
    sessionStorage.removeItem(IP_KEY);
  } catch { /* 저장소 사용 불가 시 무시 */ }
}

/** 접속 1회 기록. 같은 로그인·같은 탭에서는 한 번만 남긴다. */
export async function logAccessOncePerVisit(p: {
  orgId: string;
  userId: string;
  userName: string | null;
  signInAt: string | null;
  getIp: IpFetcher;
}): Promise<void> {
  if (typeof window === "undefined") return;
  // 예전(하루 1회) 방식이 남긴 키 정리
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(KEY_PREFIX))
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* 무시 */ }

  const key = `${KEY_PREFIX}${p.userId}:${p.signInAt ?? ""}`;
  try {
    if (sessionStorage.getItem(key)) return;
  } catch { /* 저장소를 못 쓰면 기록만 시도 */ }
  if (inflight.has(key)) return;
  inflight.add(key);
  try {
    // 새 접속이므로 저장된 IP를 쓰지 않고 새로 확인한다(네트워크가 바뀌었을 수 있음)
    const res = await withTimeout(p.getIp(), 3000);
    const ip = res?.ip ?? null;
    rememberIp(ip);
    const ok = await insertRow(
      { org_id: p.orgId, user_id: p.userId, user_name: p.userName, action: "접속", device: detectDevice() },
      ip,
    );
    if (ok) {
      try { sessionStorage.setItem(key, "1"); } catch { /* 무시 */ }
    }
  } finally {
    inflight.delete(key);
  }
}

/** 로그아웃 기록. 로그아웃이 늦어지지 않도록 최대 1.5초만 기다린다. */
export async function logLogout(p: {
  orgId: string;
  userId: string;
  userName: string | null;
}): Promise<void> {
  if (typeof window === "undefined") return;
  const ip = cachedIp ?? readStoredIp();
  clearVisitKeys(); // 같은 탭에서 다시 로그인하면 새 접속으로 기록되도록
  try {
    await withTimeout(
      insertRow(
        { org_id: p.orgId, user_id: p.userId, user_name: p.userName, action: "로그아웃", device: detectDevice() },
        ip,
      ),
      1500,
    );
  } catch { /* 기록 실패는 로그아웃을 막지 않는다 */ }
}
