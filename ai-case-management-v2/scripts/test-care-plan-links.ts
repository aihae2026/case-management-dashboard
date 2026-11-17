// 계획 항목 연결(care_plan_action_links) 읽기·쓰기 규칙 시험. 표가 연결 정보의 유일한 저장소다.
// 실행: bun scripts/test-care-plan-links.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyLinksToActions,
  deleteCarePlanActionLinks,
  deleteLinksForAction,
  insertCarePlanActionLinks,
  overrideActionLinks,
  syncCarePlanActionLinks,
  type CarePlanLinkRow,
} from "../src/lib/care-plan-links";
import type { ActiveAction, CarePlanAction } from "../src/lib/case-types";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  → " + extra : ""}`);
}

const row = (action: string, type: "log" | "prov", id: string, excluded = false): CarePlanLinkRow => ({
  client_id: "c1", org_id: "o1", plan_year: 2026, action_id: action, link_type: type, linked_id: id, excluded,
});

// ── 읽기: 표 값으로만 채운다 ───────────────────────────────────────────
// note 에 옛 값이 남아 있어도 표에 없으면 '연결 없음'이어야 한다(해제한 연결이 되살아나지 않게)
const staleNote: CarePlanAction[] = [
  { id: "a1", text: "t1", linkedLogIds: ["OLD-LOG"], linkedProvIds: ["OLD-PROV"], excludedLogIds: ["OLD-EX"] },
  { id: "a2", text: "t2" },
];
let out = overrideActionLinks(staleNote, []);
check("표에 행이 하나도 없으면 note 의 옛 값은 무시하고 빈 연결", out.every((a) => a.linkedLogIds?.length === 0 && a.linkedProvIds?.length === 0 && a.excludedLogIds?.length === 0 && a.excludedProvIds?.length === 0));
out = overrideActionLinks(staleNote, [row("a1", "log", "L1"), row("a1", "log", "L1"), row("a1", "prov", "P1"), row("a1", "log", "X1", true), row("a1", "prov", "X2", true)]);
check("표 값으로 채운다(중복 제거)", JSON.stringify(out[0].linkedLogIds) === '["L1"]' && JSON.stringify(out[0].linkedProvIds) === '["P1"]', JSON.stringify(out[0]));
check("제외 표시도 표 값으로", JSON.stringify(out[0].excludedLogIds) === '["X1"]' && JSON.stringify(out[0].excludedProvIds) === '["X2"]');
check("표에 없는 다른 항목은 연결 없음(note 옛 값도 없음)", out[1].linkedLogIds?.length === 0 && out[1].linkedProvIds?.length === 0);
check("원본 배열·객체는 바꾸지 않는다", staleNote[0].linkedLogIds?.[0] === "OLD-LOG");
check("id 가 없는 항목도 안전", overrideActionLinks([{ text: "x" } as unknown as CarePlanAction], [row("a1", "log", "L1")])[0].linkedLogIds?.length === 0);

const aa: ActiveAction[] = [
  { reassessedAt: "2026-01-01", rowId: "r", area: "a", role: "self", action: staleNote[0], planYear: 2026 },
];
const applied = applyLinksToActions(aa, [row("a1", "log", "L9")]);
check("applyLinksToActions 도 표 값으로 채운다", applied[0].action.linkedLogIds?.[0] === "L9" && applied[0].planYear === 2026);
check("applyLinksToActions: 표가 비어 있어도 note 옛 값은 쓰지 않는다", applyLinksToActions(aa, [])[0].action.linkedLogIds?.length === 0);

// ── 쓰기: 성공 여부를 돌려준다 ────────────────────────────────────────
type Call = { table: string; ops: string[] };
function mockSb(result: { data?: unknown; error?: { message: string } | null }, calls: Call[] = []) {
  const make = (table: string) => {
    const call: Call = { table, ops: [] };
    calls.push(call);
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "delete", "upsert", "order", "range"]) {
      b[m] = (...args: unknown[]) => {
        call.ops.push(`${m}(${args.map((a) => (typeof a === "string" ? a : typeof a === "object" ? "{…}" : String(a))).join(",")})`);
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => void) => resolve({ data: result.data ?? null, error: result.error ?? null });
    return b;
  };
  return { from: make } as unknown as SupabaseClient;
}
const params = { clientId: "c1", orgId: "o1", linkedId: "L1", kind: "log" as const, actionIds: new Set(["a1", "a2"]), yearByActionId: new Map([["a1", 2025], ["a2", 2026]]) };

let calls: Call[] = [];
check("insert 성공 → true", (await insertCarePlanActionLinks(mockSb({}, calls), params)) === true);
check("insert 는 표(care_plan_action_links)만 건드린다", calls.length === 1 && calls[0].table === "care_plan_action_links" && calls[0].ops[0].startsWith("upsert"));
check("insert 실패 → false", (await insertCarePlanActionLinks(mockSb({ error: { message: "x" } }), params)) === false);
check("insert: 항목이 없으면 DB 호출 없이 true", (await insertCarePlanActionLinks(mockSb({ error: { message: "호출되면 안 됨" } }), { ...params, actionIds: new Set() })) === true);
check("delete 성공 → true", (await deleteCarePlanActionLinks(mockSb({}), { clientId: "c1", kind: "log", linkedId: "L1", actionIds: ["a1"] })) === true);
check("delete 실패 → false", (await deleteCarePlanActionLinks(mockSb({ error: { message: "x" } }), { clientId: "c1", kind: "log", linkedId: "L1", actionIds: ["a1"] })) === false);
check("delete: 빈 항목 목록이면 DB 호출 없이 true", (await deleteCarePlanActionLinks(mockSb({ error: { message: "호출되면 안 됨" } }), { clientId: "c1", kind: "log", linkedId: "L1", actionIds: [] })) === true);
check("deleteLinksForAction 실패 → false", (await deleteLinksForAction(mockSb({ error: { message: "x" } }), { clientId: "c1", actionId: "a1" })) === false);

// sync: 기존 행 a1,a3 → 목표 a1,a2 : a3 삭제 + a2 추가
calls = [];
const syncOk = await syncCarePlanActionLinks(mockSb({ data: [{ action_id: "a1" }, { action_id: "a3" }] }, calls), params);
const ops = calls.flatMap((c) => c.ops);
check("sync 성공 → true", syncOk === true);
check("sync: 목표에 없는 기존 행(a3)만 삭제 호출", ops.some((o) => o.includes("delete")) && ops.some((o) => o.includes("in(action_id,")));
check("sync: 조회가 실패하면 false(아무것도 지우거나 넣지 않음)", (await syncCarePlanActionLinks(mockSb({ error: { message: "x" } }), params)) === false);

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
