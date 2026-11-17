/** SSRF 방어: 내부 IP·로컬 호스트·사설망 판별 (호스트 이름/IP 문자열 기준) */
export function isPrivateHost(hostname: string): boolean {
  // IPv6 주소는 URL에서 대괄호([::1])로 오므로 벗기고, 끝 점(localhost.)과 대소문자를 정규화한다
  hostname = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (!hostname) return true;
  if (hostname === "localhost" || hostname === "::1") return true;
  // .local / .internal / .localhost 도메인
  if (/\.(local|internal|localhost)$/.test(hostname)) return true;
  // IPv4 사설망·링크로컬·루프백·예약 대역
  const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]), c = Number(v4[3]);
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 169 && b === 254) return true;            // 링크로컬(클라우드 메타데이터 포함)
    if (a === 127) return true;                         // 루프백
    if (a === 0) return true;                           // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true;  // 공유주소 100.64.0.0/10
    if (a === 192 && b === 0 && c === 0) return true;   // 192.0.0.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 벤치마크
    if (a >= 224) return true;                          // 멀티캐스트·예약·브로드캐스트
  }
  // IPv6 (':'이 있는 주소만 해당)
  if (hostname.includes(":")) {
    if (hostname === "::1" || hostname === "::") return true;
    if (/^f[cd]/.test(hostname)) return true;           // fc00::/7 고유 로컬
    if (/^fe[89abcdef]/.test(hostname)) return true;    // fe80::/10 링크로컬, fec0::/10 사이트로컬
    if (/^ff/.test(hostname)) return true;              // 멀티캐스트
    if (/^::ffff:/.test(hostname)) return true;         // IPv4 매핑
    if (/^64:ff9b:/.test(hostname)) return true;        // NAT64
  }
  return false;
}

/**
 * 공개 이름이 내부 IP로 풀리는 경우를 막는다.
 * DNS 조회 자체가 실패하거나 런타임이 지원하지 않으면 허용(로그만 남김) — 그 경우 fetch가 어차피 실패한다.
 */
export async function resolvesToPrivate(hostname: string): Promise<boolean> {
  const h = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (h.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false; // IP 리터럴은 이미 검사됨
  for (const type of ["A", "AAAA"] as const) {
    try {
      const records = await Deno.resolveDns(h, type);
      if (records.some((ip) => isPrivateHost(ip))) return true;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) console.warn("[fetch-url] DNS 확인 생략:", type, (e as Error).message);
    }
  }
  return false;
}
