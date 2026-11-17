import { createHash } from "node:crypto";

// 비밀값을 로그에 남기지 않고도 "저쪽이 가진 값과 같은지" 가려낼 수 있도록 지문만 만든다.
// 길이, 앞뒤 공백이 있었는지, SHA-256 앞 8글자만 남기므로 비밀값 자체는 알 수 없다.
export function describeSecret(raw: string): string {
  const trimmed = raw.trim();
  const sha = createHash("sha256").update(trimmed).digest("hex").slice(0, 8);
  const spaces = raw !== trimmed ? "있었음(제거하고 사용)" : "없음";
  return `길이=${trimmed.length} 앞뒤공백=${spaces} sha256앞8=${sha}`;
}
