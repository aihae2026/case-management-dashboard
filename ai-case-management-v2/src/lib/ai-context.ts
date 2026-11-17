/**
 * AI 상담 다듬기에 '참고 자료'로 함께 보내는 이전 상담기록·문체 예시를 만든다.
 *
 * - 저장된 상담기록 첫 줄에는 대상자 이름이 들어 있어서, 그대로 보내면 이름이 매번 AI 로 나간다.
 *   그래서 첫 줄 이름을 '대상자'로 바꾸고, 본문에 이 대상자 이름이 나오면 그것도 '대상자'로 바꿔 보낸다(되돌릴 필요 없음).
 * - 문체 예시는 이 대상자의 이전 기록을 먼저 쓴다. 없으면 같은 기관의 다른 대상자 기록을 쓰되,
 *   본문에 등록된 대상자 이름이 남아 있는 기록은 빼고 이름이 없는 것만 쓴다. 하나도 없으면 예시 없이 보낸다.
 * - 담당자가 직접 쓴 초안·작성 방향은 건드리지 않는다. 등록되지 않은 이름(보호자·가족 등)은 알 수 없어 걸러내지 못한다.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAiBlockedIds } from "./ai-consent";
import { maskNamesInText, neutralizeHeaderName, type NameRef } from "./ai-names";
import { toKstDate } from "./log-time";

const NOTE_MAX_CHARS = 300;
const HISTORY_COUNT = 5;
const SAMPLE_COUNT = 3;
/** 다른 대상자 기록에서 이름 없는 예시를 찾을 때 살펴보는 최근 기록 수 */
const FALLBACK_SCAN = 40;

type NoteLike = { id?: string; note?: string | null; created_at: string; client_id?: string };

/** 한 기록을 AI 로 보내기 전에 정리: 첫 줄 이름 → '대상자', 본문 속 이 대상자 이름 → '대상자' */
export function sanitizeNoteForAi(note: string | null | undefined, own: NameRef[]): string {
  const t = neutralizeHeaderName(note ?? "");
  return maskNamesInText(t, own).text;
}

/** 이전 상담 현황(맥락용): 최근 기록 몇 건을 날짜와 함께. 기록은 빼지 않고 이름만 지운다. */
export function buildHistory(thread: NoteLike[], own: NameRef[], excludeId?: string | null): { date: string; text: string }[] {
  return thread
    .filter((l) => l.id !== excludeId)
    .slice(-HISTORY_COUNT)
    .map((l) => ({ date: toKstDate(l.created_at), text: sanitizeNoteForAi(l.note, own).slice(0, NOTE_MAX_CHARS) }));
}

/**
 * 문체 예시 고르기.
 * 1) 이 대상자의 이전 기록(최근 몇 건): 이름을 지워 쓰되, 다른 등록 대상자 이름이 본문에 남아 있으면 뺀다.
 * 2) 없으면 다른 대상자 기록: 첫 줄 이름을 지운 뒤 본문에 등록된 이름이 하나라도 있으면 뺀다.
 */
export function selectSamples(args: {
  ownNotes: NoteLike[];
  otherNotes: NoteLike[];
  own: NameRef[];
  allClients: NameRef[];
}): string[] {
  const { ownNotes, otherNotes, own, allClients } = args;
  const others = allClients.filter((c) => !own.some((o) => (o.id && o.id === c.id) || o.name === c.name));

  const fromOwn = ownNotes
    .slice(-SAMPLE_COUNT)
    .map((l) => sanitizeNoteForAi(l.note, own).slice(0, NOTE_MAX_CHARS))
    .filter((t) => t.trim() && maskNamesInText(t, others).count === 0);
  if (fromOwn.length > 0) return fromOwn;

  const picked: string[] = [];
  for (const l of otherNotes) {
    const t = neutralizeHeaderName(l.note ?? "").slice(0, NOTE_MAX_CHARS);
    if (!t.trim()) continue;
    if (maskNamesInText(t, allClients).count > 0) continue; // 본문에 등록된 이름이 있으면 쓰지 않는다
    picked.push(t);
    if (picked.length >= SAMPLE_COUNT) break;
  }
  return picked;
}

export type AiContext = {
  history: { date: string; text: string }[];
  samples: string[];
};

/** 화면에서 쓰는 한 번에: 기관 대상자 이름·AI 거부 대상자·다른 대상자 기록을 조회해 위 규칙대로 만든다. */
export async function prepareAiContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: SupabaseClient<any, any, any>,
  args: { client: NameRef & { org_id: string }; thread: NoteLike[]; excludeId?: string | null },
): Promise<AiContext> {
  const { client, thread, excludeId } = args;
  const ownNotes = thread.filter((l) => l.id !== excludeId && (l.note ?? "").trim());
  const own: NameRef[] = [client];
  const history = buildHistory(thread, own, excludeId);

  // 같은 기관의 대상자 이름(본문 속 이름이 남아 있는 기록을 가려내는 데 쓴다)
  const { data: clientRows } = await sb.from("clients").select("id,name,client_code").eq("org_id", client.org_id);
  const allClients = ((clientRows ?? []) as NameRef[]).filter((c) => (c.name ?? "").trim());

  // 이 대상자의 기록만으로 예시가 채워지면 다른 대상자 기록은 조회하지 않는다
  let otherNotes: NoteLike[] = [];
  const own1 = selectSamples({ ownNotes, otherNotes: [], own, allClients });
  if (own1.length > 0) return { history, samples: own1 };

  const { data: refLogsAll } = await sb
    .from("activity_logs")
    .select("note,client_id,created_at")
    .eq("org_id", client.org_id)
    .neq("client_id", client.id) // 현재 대상자 제외
    .not("note", "is", null)
    .order("created_at", { ascending: false })
    .limit(FALLBACK_SCAN);
  // AI 활용을 거부한 대상자의 기록은 예시로 쓰지 않는다
  const blockedIds = await getAiBlockedIds(sb, { orgId: client.org_id });
  otherNotes = ((refLogsAll ?? []) as NoteLike[]).filter((l) => !(l.client_id && blockedIds.has(l.client_id)));
  return { history, samples: selectSamples({ ownNotes: [], otherNotes, own, allClients }) };
}
