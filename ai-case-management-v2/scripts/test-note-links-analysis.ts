// 7단계 사전 점검 분석(note-links-analysis.ts) 시험: 가짜 데이터로 분류가 맞는지 확인한다.
// 실행: bun scripts/test-note-links-analysis.ts
import { joinNote, type CarePlanAction, type Reassessment } from "../src/lib/case-types";
import { analyze, judge, type ClientInput, type LinkRowInput } from "./note-links-analysis";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  → " + extra : ""}`);
}

const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const act = (id: number, extra: Partial<CarePlanAction> = {}): CarePlanAction => ({ id: u(id), text: `항목${id}`, ...extra });
function mkNote(year: number, actions: CarePlanAction[]): string {
  const r = {
    reassessedAt: `${year}-01-10`,
    carePlan: { year, extractedAt: `${year}-01-10`, rows: [{ id: "r1", priority: 1, problem: "p", need: "n", selfPlan: actions, workerPlan: [] }] },
  } as unknown as Reassessment;
  return joinNote("비고 본문", [r], null, null, [], [], []);
}
const link = (client: number, year: number, action: number, type: "log" | "prov", id: number, excluded = false): LinkRowInput => ({
  client_id: u(client), plan_year: year, action_id: u(action), link_type: type, linked_id: u(id), excluded,
});

const clients: ClientInput[] = [
  // 1) 정상: note 와 표가 같음
  { id: u(1), org_id: u(900), client_code: "JN0001", note: mkNote(2026, [act(11, { linkedLogIds: [u(101)] })]) },
  // 2) 표에 행이 없는 항목의 note 연결(지금 화면에 보임) — 로그 1 + 제공 1
  { id: u(2), org_id: u(900), client_code: "JN0002", note: mkNote(2026, [act(21, { linkedLogIds: [u(102)], linkedProvIds: [u(201)] })]) },
  // 3) 표에 행이 있는 항목에 note 에만 있는 옛 연결(지금도 안 보임)
  { id: u(3), org_id: u(900), client_code: "JN0003", note: mkNote(2026, [act(31, { linkedLogIds: [u(103), u(104)] })]) },
  // 4) 표 행의 항목이 note 에 없음(고아)
  { id: u(4), org_id: u(900), client_code: "JN0004", note: mkNote(2026, [act(41)]) },
  // 5) 연도 어긋남
  { id: u(5), org_id: u(900), client_code: "JN0005", note: mkNote(2026, [act(51)]) },
  // 6) 연결 대상이 삭제됨
  { id: u(6), org_id: u(900), client_code: "JN0006", note: mkNote(2026, [act(61)]) },
  // 7) 분해→조립이 원본과 달라지는 note (JSON 서식이 앱이 쓰는 모양이 아님)
  { id: u(7), org_id: u(900), client_code: "JN0007", note: mkNote(2026, [act(71)]).replace('","', '", "') },
  // 8) 제외(excluded) 연결만 note 에 있음, 표 행 없음
  { id: u(8), org_id: u(900), client_code: "JN0008", note: mkNote(2026, [act(81, { excludedLogIds: [u(105)] })]) },
  // 9) 연결 정보가 전혀 없는 대상자, 빈 note
  { id: u(9), org_id: u(900), client_code: "JN0009", note: "" },
  { id: u(10), org_id: u(900), client_code: "JN0010", note: null },
  // 11) 같은 항목 ID 가 두 해 계획서에 나타남
  {
    id: u(11), org_id: u(900), client_code: "JN0011",
    note: joinNote("", [
      { reassessedAt: "2025-01-10", carePlan: { year: 2025, extractedAt: "x", rows: [{ id: "r", priority: 1, problem: "p", need: "n", selfPlan: [act(111)], workerPlan: [] }] } } as unknown as Reassessment,
      { reassessedAt: "2026-01-10", carePlan: { year: 2026, extractedAt: "x", rows: [{ id: "r", priority: 1, problem: "p", need: "n", selfPlan: [act(111)], workerPlan: [] }] } } as unknown as Reassessment,
    ], null, null, [], [], []),
  },
];

const links: LinkRowInput[] = [
  link(1, 2026, 11, "log", 101),
  link(3, 2026, 31, "log", 103), // 31 항목에 행이 있어서 note 의 104 는 무시됨
  link(4, 2026, 999, "log", 106), // 고아
  link(5, 2025, 51, "log", 107), // 연도 어긋남(note 계획서는 2026)
  link(6, 2026, 61, "log", 108), // 대상 삭제됨
];
const logIds = new Set([101, 102, 103, 104, 105, 106, 107].map(u));
const provIds = new Set([201].map(u));

const rep = analyze({ clients, links, logIds, provIds });

check("대상자 수", rep.clients === 11);
check("note 에 연결이 있는 대상자 수(1,2,3,8)", rep.clientsWithNoteLinks === 4, String(rep.clientsWithNoteLinks));
check("note 연결 건수: 연결 5건(1번 1건, 2번 2건, 3번 2건)", rep.noteLinkCounts.linked === 1 + 2 + 2, JSON.stringify(rep.noteLinkCounts));
check("note 제외 건수 1", rep.noteLinkCounts.excluded === 1);
check("표 행 5건(연결)", rep.tableLinkCounts.linked === 5 && rep.tableLinkCounts.excluded === 0);
check("표에 행이 없는 항목의 note 연결: 항목 2개(2번·8번)", rep.displayedOnlyInNote.actions === 2, String(rep.displayedOnlyInNote.actions));
check("그 연결 건수: 연결 2건(로그1+제공1), 제외 1건", rep.displayedOnlyInNote.linked === 2 && rep.displayedOnlyInNote.excluded === 1, JSON.stringify({ l: rep.displayedOnlyInNote.linked, e: rep.displayedOnlyInNote.excluded }));
check("예시에는 대상자 번호와 항목 앞 8자리만", rep.displayedOnlyInNote.examples.every((e) => /^JN\d{4}$/.test(e.client) && e.action.length === 8), JSON.stringify(rep.displayedOnlyInNote.examples));
check("표에 행이 있는 항목의 note 에만 있는 연결 1건(104)", rep.ignoredNoteOnly.linked === 1 && rep.ignoredNoteOnly.excluded === 0, JSON.stringify(rep.ignoredNoteOnly));
check("고아 표 행 1건", rep.orphanTableRows === 1);
check("연도 어긋난 표 행 1건", rep.yearMismatchRows === 1);
check("삭제된 대상을 가리키는 표 행 1건", rep.danglingTableRows === 1, String(rep.danglingTableRows));
check("같은 항목 ID 가 여러 계획서에 나타나는 경우 1건", rep.duplicateActionIds === 1, String(rep.duplicateActionIds));
check("분해→조립이 원본과 다른 note 가 7번만", rep.roundTrip.notIdentical === 1 && rep.roundTrip.examples[0] === "JN0007", JSON.stringify(rep.roundTrip));

check("note 연결이 남은 대상자 목록(1,2,3,8번)과 대상자 번호만 담긴다", JSON.stringify(rep.noteLinkClients.map((c) => c.client)) === '["JN0001","JN0002","JN0003","JN0008"]', JSON.stringify(rep.noteLinkClients));
check("표 연결이 1개뿐인 항목 수(1번 11항목, 3번 31항목)", rep.noteLinkClients.find((c) => c.client === "JN0001")?.singleLinkActions === 1 && rep.noteLinkClients.find((c) => c.client === "JN0003")?.singleLinkActions === 1 && rep.noteLinkClients.find((c) => c.client === "JN0002")?.singleLinkActions === 0);

const v = judge(rep);
check("판정: 막을 항목이 있으면 ok=false", !v.ok && v.blockers.length === 2, `blockers=${v.blockers.length}`);
check("판정: 백필을 그대로 다시 돌리지 말라는 안내 포함", v.notes.some((n) => n.includes("백필")));

// 문제가 없는 경우
const clean = analyze({
  clients: [clients[0]],
  links: [link(1, 2026, 11, "log", 101)],
  logIds,
  provIds,
});
const vc = judge(clean);
check("깨끗한 경우 ok=true", vc.ok && vc.blockers.length === 0 && clean.displayedOnlyInNote.actions === 0, JSON.stringify(vc));

// 이미 정리된 note(연결 필드 없음)
const cleaned = analyze({ clients: [{ id: u(1), org_id: u(900), note: mkNote(2026, [act(11)]) }], links: [link(1, 2026, 11, "log", 101)] });
check("정리 뒤 상태: note 연결 0건, 표 1건, ok", cleaned.clientsWithNoteLinks === 0 && cleaned.noteLinkCounts.linked === 0 && judge(cleaned).ok);

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
