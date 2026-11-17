import { createContext, useContext } from "react";

/**
 * 화면의 "이름 숨기기" 상태.
 * 켜면 대상자 이름 대신 대상자 번호(JN0001)를 보여 준다. 회의·화면 공유·시연·캡처용이며 저장된 데이터는 바뀌지 않는다.
 * 이름 칸만 가리고, 상담 내용 같은 글 속의 이름은 그대로 보인다.
 */
export type NameMaskState = { hidden: boolean; setHidden: (v: boolean) => void };

export const NameMaskContext = createContext<NameMaskState>({ hidden: false, setHidden: () => {} });

export function useNameMask(): NameMaskState {
  return useContext(NameMaskContext);
}

type NameLike = { name?: string | null; client_code?: string | null };

/** 숨기기 상태에 맞는 표시 이름. 번호가 아직 없으면 "대상자". */
export function maskedName(c: NameLike | null | undefined, hidden: boolean, fallback = ""): string {
  if (!c) return fallback;
  if (!hidden) return c.name ?? fallback;
  return c.client_code ?? "대상자";
}
