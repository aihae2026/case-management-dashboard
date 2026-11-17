import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 시각을 한국 시간 기준 "YYYY-MM-DD"로 바꾼다.
// toISOString().slice(0, 10)은 UTC 날짜라서 한국 시간 0~9시가 전날로 계산된다.
export function kstDate(d: Date | string | number = new Date()): string {
  return new Date(d).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

// 오늘 날짜(한국 시간)를 "YYYY-MM-DD" 형식으로 반환 (localStorage dedupe 키 등에 사용)
export function today(): string {
  return kstDate();
}
