import { useEffect } from "react";
import { logView, type ViewTarget } from "@/lib/view-log";

/** 화면에서 대상자 한 명을 열어 보면 열람 기록을 남긴다. detail 에는 어느 화면인지(예: "대상자관리")만 쓴다. */
export function useClientViewLog(client: ViewTarget, detail: string) {
  const id = client?.id ?? null;
  const code = client?.client_code ?? null;
  useEffect(() => {
    if (id) logView({ action: "상세 열람", client: { id, client_code: code }, detail });
  }, [id, code, detail]);
}
