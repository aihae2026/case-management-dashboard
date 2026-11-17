import type { SupabaseClient } from "@supabase/supabase-js";
import type { CarePlanAction, ActiveAction } from "./case-types";

// ── 타입 ──────────────────────────────────────────────────────────────
export type CarePlanLinkRow = {
  client_id: string;
  org_id: string;
  plan_year: number;
  action_id: string;
  link_type: "log" | "prov";
  linked_id: string;
  excluded: boolean;
};

/**
 * action 배열의 linked* / excluded* 필드를 care_plan_action_links 테이블 데이터로 채운다.
 * 계획 항목과 상담기록·제공이력의 연결은 이 테이블에만 저장하고, clients.note 의 같은 필드는 더 이상 읽지 않는다.
 * 표에 행이 없는 항목은 '연결 없음'(빈 배열)이 된다.
 * clientLinks는 해당 client_id + plan_year 로 이미 필터된 상태로 전달.
 */
export function overrideActionLinks(
  actions: CarePlanAction[],
  clientLinks: CarePlanLinkRow[],
): CarePlanAction[] {
  const byActionId = new Map<string, { ll: string[]; pl: string[]; el: string[]; ep: string[] }>();
  for (const l of clientLinks) {
    if (!byActionId.has(l.action_id)) byActionId.set(l.action_id, { ll: [], pl: [], el: [], ep: [] });
    const e = byActionId.get(l.action_id)!;
    if (l.link_type === "log"  && !l.excluded) e.ll.push(l.linked_id);
    if (l.link_type === "prov" && !l.excluded) e.pl.push(l.linked_id);
    if (l.link_type === "log"  &&  l.excluded) e.el.push(l.linked_id);
    if (l.link_type === "prov" &&  l.excluded) e.ep.push(l.linked_id);
  }
  const uniq = (xs: string[]) => [...new Set(xs)];
  return actions.map((a) => {
    const o = byActionId.get(a.id ?? "");
    return {
      ...a,
      linkedLogIds: uniq(o?.ll ?? []),
      linkedProvIds: uniq(o?.pl ?? []),
      excludedLogIds: uniq(o?.el ?? []),
      excludedProvIds: uniq(o?.ep ?? []),
    };
  });
}

/** ActiveAction[] 래퍼: overrideActionLinks와 동일하지만 ActiveAction 구조 처리 */
export function applyLinksToActions(
  actions: ActiveAction[],
  clientLinks: CarePlanLinkRow[],
): ActiveAction[] {
  const baseActions = actions.map((aa) => aa.action);
  const overridden = overrideActionLinks(baseActions, clientLinks);
  return actions.map((aa, i) => ({ ...aa, action: overridden[i] }));
}

/**
 * org 전체 care_plan_action_links 조회 (Supabase 생성 타입에 테이블이 없어서 SupabaseClient 경유).
 * 서버 기본 최대 1000행 제한을 넘겨도 잘리지 않도록 페이지 단위로 전부 읽는다.
 * 중간에 실패하면 일부만 쓰는 것보다 안전하도록 null 을 돌려준다(호출한 쪽이 이전 값을 유지하고 알려야 한다).
 */
export async function fetchCarePlanActionLinks(
  supabase: SupabaseClient,
  orgId: string,
): Promise<CarePlanLinkRow[] | null> {
  const PAGE = 1000;
  const all: CarePlanLinkRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("care_plan_action_links")
      .select("*")
      .eq("org_id", orgId)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn("[care-plan-links] fetch failed:", error.message);
      return null;
    }
    const page = (data ?? []) as unknown as CarePlanLinkRow[];
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all;
}

/** ActiveAction[] → actionId별 계획서 연도 맵 (links 테이블 plan_year 기록용) */
export function yearMapOf(actions: ActiveAction[]): Map<string, number> {
  return new Map(actions.map((aa) => [aa.action.id, aa.planYear]));
}

/**
 * 상담기록·제공이력을 계획 항목에 연결(표에 INSERT). 이 표가 연결 정보의 유일한 저장소다.
 * 이미 존재하는 행은 ON CONFLICT로 무시(멱등성 보장).
 * plan_year는 yearByActionId(실제 계획서 연도) → planYear → 올해 순으로 결정.
 * 성공 여부를 돌려준다(실패하면 호출한 쪽이 사용자에게 알려야 한다).
 */
export async function insertCarePlanActionLinks(
  supabase: SupabaseClient,
  params: {
    clientId: string;
    orgId: string;
    linkedId: string;
    kind: "log" | "prov";
    actionIds: Set<string>;
    planYear?: number;
    yearByActionId?: Map<string, number>;
  },
): Promise<boolean> {
  const { clientId, orgId, linkedId, kind, actionIds, planYear, yearByActionId } = params;
  if (actionIds.size === 0) return true;

  const rows = [...actionIds].map((actionId) => ({
    client_id: clientId,
    org_id: orgId,
    plan_year: yearByActionId?.get(actionId) ?? planYear ?? new Date().getFullYear(),
    action_id: actionId,
    link_type: kind,
    linked_id: linkedId,
  }));

  const { error } = await supabase
    .from("care_plan_action_links")
    .upsert(rows, {
      onConflict: "client_id,plan_year,action_id,link_type,linked_id",
      ignoreDuplicates: true,
    });
  if (error) console.warn("[care-plan-links] upsert failed:", error.message);
  return !error;
}

/** 특정 상담기록/제공이력(linkedId)의 연동을 해제 — actionIds 지정 시 해당 항목만, 생략 시 전체. 성공 여부를 돌려준다. */
export async function deleteCarePlanActionLinks(
  supabase: SupabaseClient,
  params: {
    clientId: string;
    kind: "log" | "prov";
    linkedId: string;
    actionIds?: string[];
  },
): Promise<boolean> {
  const { clientId, kind, linkedId, actionIds } = params;
  if (actionIds && actionIds.length === 0) return true;
  let q = supabase
    .from("care_plan_action_links")
    .delete()
    .eq("client_id", clientId)
    .eq("link_type", kind)
    .eq("linked_id", linkedId);
  if (actionIds) q = q.in("action_id", actionIds);
  const { error } = await q;
  if (error) console.warn("[care-plan-links] delete failed:", error.message);
  return !error;
}

/** 행동계획 항목 삭제 시 해당 항목에 걸린 연동 행 전체 정리. 성공 여부를 돌려준다. */
export async function deleteLinksForAction(
  supabase: SupabaseClient,
  params: { clientId: string; actionId: string },
): Promise<boolean> {
  const { error } = await supabase
    .from("care_plan_action_links")
    .delete()
    .eq("client_id", params.clientId)
    .eq("action_id", params.actionId);
  if (error) console.warn("[care-plan-links] delete-by-action failed:", error.message);
  return !error;
}

/**
 * 수정 화면용 완전 동기화: linkedId의 연동 대상을 actionIds와 정확히 일치시킨다.
 * 기존 행 중 actionIds에 없는 것은 삭제, 새로 선택된 것은 추가. 둘 다 성공해야 true.
 */
export async function syncCarePlanActionLinks(
  supabase: SupabaseClient,
  params: {
    clientId: string;
    orgId: string;
    linkedId: string;
    kind: "log" | "prov";
    actionIds: Set<string>;
    yearByActionId?: Map<string, number>;
  },
): Promise<boolean> {
  const { clientId, kind, linkedId, actionIds } = params;
  const { data, error } = await supabase
    .from("care_plan_action_links")
    .select("action_id")
    .eq("client_id", clientId)
    .eq("link_type", kind)
    .eq("linked_id", linkedId)
    .eq("excluded", false);
  if (error) {
    console.warn("[care-plan-links] sync select failed:", error.message);
    return false;
  }
  const existing = new Set((data ?? []).map((r: { action_id: string }) => r.action_id));
  const toRemove = [...existing].filter((id) => !actionIds.has(id));
  const removed = await deleteCarePlanActionLinks(supabase, { clientId, kind, linkedId, actionIds: toRemove });
  const added = await insertCarePlanActionLinks(supabase, params);
  return removed && added;
}
