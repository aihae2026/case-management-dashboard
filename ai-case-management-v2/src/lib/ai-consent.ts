import type { SupabaseClient } from "@supabase/supabase-js";

// 대상자별 AI 기능 활용 설정: agree(동의)한 대상자만 AI를 사용하고, unset(미설정)·refuse(거부)는 AI에서 제외한다.
export type AiConsent = "unset" | "agree" | "refuse";

export const AI_REFUSED_MESSAGE =
  "AI 활용에 동의하지 않았거나 거부한 대상자입니다. 대상자 관리에서 설정을 확인해 주세요.";

// 대상자 정보에 ai_consent 값이 없으면(조회 항목에 빠졌거나 컬럼 추가 전) 기존처럼 제한하지 않는다.
export function isAiBlocked(c?: { ai_consent?: string | null } | null): boolean {
  const v = c?.ai_consent;
  return v != null && v !== "agree";
}

// 서버(Database 타입)·브라우저 클라이언트를 모두 받기 위해 스키마 제네릭은 느슨하게 둔다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = Pick<SupabaseClient<any, any, any>, "from">;

// DB에 ai_consent 컬럼이 아직 없으면(마이그레이션 전) 기존처럼 제한 없이 동작한다. 그 밖의 오류는 막는다.
function isMissingColumn(err: { code?: string; message?: string }): boolean {
  return err.code === "42703" || (/ai_consent/.test(err.message ?? "") && /column|schema cache/i.test(err.message ?? ""));
}

const CHUNK = 100;

/** 동의하지 않은(미설정·거부) 대상자 id 집합. ids를 주면 그중에서, orgId를 주면 기관 전체에서 찾는다. */
export async function getAiBlockedIds(
  sb: Sb,
  scope: { orgId?: string | null; ids?: string[] },
): Promise<Set<string>> {
  const out = new Set<string>();
  const batches: (string[] | undefined)[] = scope.ids
    ? Array.from({ length: Math.ceil(scope.ids.length / CHUNK) }, (_, i) => scope.ids!.slice(i * CHUNK, (i + 1) * CHUNK))
    : [undefined];
  for (const ids of batches) {
    let q = sb.from("clients").select("id").neq("ai_consent", "agree");
    if (scope.orgId) q = q.eq("org_id", scope.orgId);
    if (ids) q = q.in("id", ids);
    const { data, error } = await q;
    if (error) {
      if (isMissingColumn(error)) return new Set();
      throw new Error(`AI 활용 동의 확인에 실패했습니다: ${error.message}`);
    }
    for (const r of (data ?? []) as { id: string }[]) out.add(r.id);
  }
  return out;
}

/** 대상자가 AI 활용에 동의하지 않았으면(미설정·거부) 오류를 던진다. clientId가 없으면 검사하지 않는다. */
export async function assertAiAllowed(sb: Sb, clientId?: string | null): Promise<void> {
  if (!clientId) return;
  const blocked = await getAiBlockedIds(sb, { ids: [clientId] });
  if (blocked.has(clientId)) throw new Error(AI_REFUSED_MESSAGE);
}

/** 목록에서 AI 활용에 동의하지 않은 대상자를 뺀다. */
export async function filterAiAllowed<T extends { id: string }>(
  sb: Sb,
  list: T[],
): Promise<{ allowed: T[]; excluded: number }> {
  if (list.length === 0) return { allowed: list, excluded: 0 };
  const blocked = await getAiBlockedIds(sb, { ids: list.map((c) => c.id) });
  if (blocked.size === 0) return { allowed: list, excluded: 0 };
  const allowed = list.filter((c) => !blocked.has(c.id));
  return { allowed, excluded: list.length - allowed.length };
}
