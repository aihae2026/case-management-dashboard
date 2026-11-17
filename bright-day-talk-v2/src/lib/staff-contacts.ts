// 담당 사회복지사 연락처 — 환경변수로 관리 (U-20)
// 서버에서는 STAFF_{BAEK,LEE}_{NAME,PHONE} 를 process.env 로 읽고,
// 브라우저 번들에 넣어야 하면 같은 이름 앞에 VITE_ 를 붙인 값을 쓴다.
// 로그인 화면과 채팅 화면의 담당자 표시는 /api/staff-contacts 가 서버에서 내려주고,
// 이 파일은 AI 프롬프트(companion-prompt.ts)의 연락처 폴백에 쓰인다.

const e = (key: string) =>
  (import.meta.env[`VITE_${key}`] as string | undefined)?.trim() ||
  (typeof process !== "undefined" ? process.env[key] : undefined)?.trim() ||
  "";

export const STAFF_CONTACTS = {
  baek: {
    name: e("STAFF_BAEK_NAME") || "담당 사회복지사",
    phone: e("STAFF_BAEK_PHONE"),
  },
  lee: {
    name: e("STAFF_LEE_NAME") || "담당 사회복지사",
    phone: e("STAFF_LEE_PHONE"),
  },
} as const satisfies Record<string, { name: string; phone: string }>;
