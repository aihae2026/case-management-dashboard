import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * 화면에 표시하는 AI 모델 이름은 코드에 적어 두지 않고 서버가 알려 주는 값만 쓴다.
 * - 설정된 모델: 'gemini' 함수에 핑을 보내 서버 비밀값(GEMINI_MODEL)을 읽은 값. 비밀값을 바꾸면 새로고침하거나 5분 뒤 반영된다.
 * - 실제로 쓴 모델: AI 호출 응답에 들어 있는 model 값(대체 모델로 처리됐다면 그 이름).
 */
export type AiModelStatus = { enabled: boolean; model: string };

const TTL_MS = 5 * 60 * 1000;
// 작업(task)별로 따로 보관한다. 작업이 없으면 기본 모델. (예: task "resource" = 자원 배분 도우미)
const cache = new Map<string, { at: number; value: AiModelStatus }>();
const inflight = new Map<string, Promise<AiModelStatus | null>>();

export async function fetchAiModelStatus(task?: string, force = false): Promise<AiModelStatus | null> {
  const key = task ?? "";
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      try {
        const { data, error } = await supabase.functions.invoke("gemini", { body: { ping: true, ...(task ? { task } : {}) } });
        if (error || !data) return null;
        const value = { enabled: !!data.enabled, model: String(data.model ?? "") };
        cache.set(key, { at: Date.now(), value });
        return value;
      } catch {
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
  }
  return p;
}

/** 현재 서버에 설정된 AI 모델 상태(불러오는 중이거나 실패하면 null) */
export function useAiModelStatus(task?: string): AiModelStatus | null {
  const [status, setStatus] = useState<AiModelStatus | null>(cache.get(task ?? "")?.value ?? null);
  useEffect(() => {
    let alive = true;
    void fetchAiModelStatus(task).then((v) => {
      if (alive) setStatus(v);
    });
    return () => {
      alive = false;
    };
  }, [task]);
  return status;
}

/** AI 호출 응답(JSON)에서 실제로 쓴 모델 이름을 꺼낸다. 없으면 null */
export function modelFromResponse(data: unknown): string | null {
  const m = (data as { model?: unknown } | null | undefined)?.model;
  return typeof m === "string" && m.trim() ? m.trim() : null;
}
