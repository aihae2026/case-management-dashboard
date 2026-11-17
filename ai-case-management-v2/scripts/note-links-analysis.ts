/**
 * note JSON 분리 7단계(clients.note 에서 linkedLogIds/linkedProvIds/excludedLogIds/excludedProvIds 제거) 전 점검용 분석.
 * DB 를 읽지 않는 순수 함수라 가짜 데이터로 시험할 수 있다(scripts/test-note-links-analysis.ts).
 * 운영 데이터는 scripts/precheck-note-links.ts 가 읽기 전용으로 가져와 이 함수에 넣는다.
 *
 * 앱의 읽기 규칙(care-plan-links.ts overrideActionLinks): 어떤 계획 항목에 표(care_plan_action_links) 행이
 * 하나라도 있으면 그 항목의 연결은 표 값으로 덮어쓰고(note 값 무시), 행이 하나도 없을 때만 note 값을 쓴다.
 * 그래서 note 에서 연결 필드를 지우면 '표에 행이 없는 항목의 note 연결'만 화면에서 사라진다.
 *
 * 출력에는 건수·대상자 번호(client_code)·항목 ID 앞 8자리만 쓴다. 이름·상담 내용은 다루지 않는다.
 */
import { joinNote, splitNote } from "../src/lib/case-types";

export type ClientInput = { id: string; org_id: string; client_code?: string | null; note: string | null };
export type LinkRowInput = {
  client_id: string;
  plan_year: number;
  action_id: string;
  link_type: "log" | "prov";
  linked_id: string;
  excluded: boolean;
};

type Where = { client: string; action: string; year: number };
const short = (id: string) => id.slice(0, 8);
const label = (c: ClientInput) => c.client_code || short(c.id);

export type Report = {
  clients: number;
  clientsWithNoteLinks: number;
  noteLinkCounts: { linked: number; excluded: number };
  tableLinkCounts: { linked: number; excluded: number };
  /** 표에 행이 없는 항목의 note 연결 = 지금 화면에 보이는데 7단계 뒤 사라지는 것 */
  displayedOnlyInNote: { linked: number; excluded: number; actions: number; examples: (Where & { logs: number; provs: number; excludedCount: number })[] };
  /** 표에 행이 있는 항목의 note 에만 있는 연결 = 지금도 안 보임(무시됨), 7단계 뒤에도 변화 없음 */
  ignoredNoteOnly: { linked: number; excluded: number };
  /** 표 행의 항목 ID 가 note 의 어느 계획 항목에도 없음 */
  orphanTableRows: number;
  /** 표 행의 plan_year 가 그 항목이 들어 있는 계획서 연도와 다름 */
  yearMismatchRows: number;
  /** 연결된 상담기록·제공이력이 이미 삭제됨 */
  danglingTableRows: number;
  /** 같은 항목 ID 가 한 대상자의 여러 계획서에 나타남 */
  duplicateActionIds: number;
  /** note 에 연결 필드가 남은 대상자 목록(대상자 번호). singleLinkActions = 표 연결이 정확히 1개인 항목 수(마지막 연결 해제 시험에 적합) */
  noteLinkClients: { client: string; actions: number; singleLinkActions: number }[];
  /** 분해 후 다시 조립하면 원본과 달라지는 note (일괄 정리 시 안전하게 다시 쓸 수 없음) */
  roundTrip: { notIdentical: number; notStable: number; examples: string[] };
};

export function analyze(input: {
  clients: ClientInput[];
  links: LinkRowInput[];
  logIds?: Set<string>;
  provIds?: Set<string>;
}): Report {
  const { clients, links, logIds, provIds } = input;
  const linksByClient = new Map<string, LinkRowInput[]>();
  for (const l of links) {
    const arr = linksByClient.get(l.client_id) ?? [];
    arr.push(l);
    linksByClient.set(l.client_id, arr);
  }

  const rep: Report = {
    clients: clients.length,
    clientsWithNoteLinks: 0,
    noteLinkCounts: { linked: 0, excluded: 0 },
    tableLinkCounts: { linked: links.filter((l) => !l.excluded).length, excluded: links.filter((l) => l.excluded).length },
    displayedOnlyInNote: { linked: 0, excluded: 0, actions: 0, examples: [] },
    ignoredNoteOnly: { linked: 0, excluded: 0 },
    orphanTableRows: 0,
    yearMismatchRows: 0,
    danglingTableRows: 0,
    duplicateActionIds: 0,
    noteLinkClients: [],
    roundTrip: { notIdentical: 0, notStable: 0, examples: [] },
  };

  if (logIds && provIds) {
    for (const l of links) {
      const exists = l.link_type === "log" ? logIds.has(l.linked_id) : provIds.has(l.linked_id);
      if (!exists) rep.danglingTableRows++;
    }
  }

  for (const c of clients) {
    const note = c.note ?? "";
    const parsed = splitNote(note);
    const rebuild = (p: ReturnType<typeof splitNote>) =>
      joinNote(p.note, p.reassessments, p.goalAnalysis, p.closeReason, p.sideDishAssessments, p.mealOpinion, p.familyMembers);

    // 일괄 정리는 분해→조립으로 note 를 다시 쓰므로, 그 과정이 원본을 그대로 돌려주는지 확인한다.
    if (note.trim()) {
      const once = rebuild(parsed);
      if (once !== note) {
        rep.roundTrip.notIdentical++;
        if (rebuild(splitNote(once)) !== once) rep.roundTrip.notStable++;
        if (rep.roundTrip.examples.length < 10) rep.roundTrip.examples.push(label(c));
      }
    }

    const myLinks = linksByClient.get(c.id) ?? [];
    const rowsByAction = new Map<string, LinkRowInput[]>();
    for (const l of myLinks) {
      const arr = rowsByAction.get(l.action_id) ?? [];
      arr.push(l);
      rowsByAction.set(l.action_id, arr);
    }
    const tableKey = (a: string, t: string, id: string, ex: boolean) => `${a}|${t}|${id}|${ex ? 1 : 0}`;
    const tableSet = new Set(myLinks.map((l) => tableKey(l.action_id, l.link_type, l.linked_id, l.excluded)));

    const seenActionYears = new Map<string, Set<number>>();
    let hasNoteLinks = false;
    let noteActionCount = 0;
    let singleLinkActions = 0;
    for (const r of parsed.reassessments) {
      if (!r.carePlan || r.carePlan.rows.length === 0) continue;
      const year = Number(r.carePlan.year);
      for (const row of r.carePlan.rows) {
        for (const action of [...(row.selfPlan ?? []), ...(row.workerPlan ?? [])]) {
          if (!action.id) continue;
          const ys = seenActionYears.get(action.id) ?? new Set<number>();
          ys.add(year);
          seenActionYears.set(action.id, ys);

          const nl = new Set(action.linkedLogIds ?? []);
          const np = new Set(action.linkedProvIds ?? []);
          const el = new Set(action.excludedLogIds ?? []);
          const ep = new Set(action.excludedProvIds ?? []);
          const linkedN = nl.size + np.size;
          const excludedN = el.size + ep.size;
          if (linkedN + excludedN === 0) continue;
          hasNoteLinks = true;
          noteActionCount++;
          if ((rowsByAction.get(action.id) ?? []).filter((x) => !x.excluded).length === 1) singleLinkActions++;
          rep.noteLinkCounts.linked += linkedN;
          rep.noteLinkCounts.excluded += excludedN;

          const hasTableRows = (rowsByAction.get(action.id) ?? []).length > 0;
          if (!hasTableRows) {
            rep.displayedOnlyInNote.linked += linkedN;
            rep.displayedOnlyInNote.excluded += excludedN;
            rep.displayedOnlyInNote.actions++;
            if (rep.displayedOnlyInNote.examples.length < 30) {
              rep.displayedOnlyInNote.examples.push({ client: label(c), action: short(action.id), year, logs: nl.size, provs: np.size, excludedCount: excludedN });
            }
          } else {
            // 표에 행이 있는 항목: note 에만 있는 연결은 지금도 무시되고 있다.
            for (const id of nl) if (!tableSet.has(tableKey(action.id, "log", id, false))) rep.ignoredNoteOnly.linked++;
            for (const id of np) if (!tableSet.has(tableKey(action.id, "prov", id, false))) rep.ignoredNoteOnly.linked++;
            for (const id of el) if (!tableSet.has(tableKey(action.id, "log", id, true))) rep.ignoredNoteOnly.excluded++;
            for (const id of ep) if (!tableSet.has(tableKey(action.id, "prov", id, true))) rep.ignoredNoteOnly.excluded++;
          }
        }
      }
    }
    if (hasNoteLinks) {
      rep.clientsWithNoteLinks++;
      rep.noteLinkClients.push({ client: label(c), actions: noteActionCount, singleLinkActions });
    }

    for (const [, ys] of seenActionYears) if (ys.size > 1) rep.duplicateActionIds++;

    // 표 쪽 이상: 항목이 note 에 없거나(고아), 연도가 어긋남
    for (const l of myLinks) {
      const ys = seenActionYears.get(l.action_id);
      if (!ys) rep.orphanTableRows++;
      else if (!ys.has(l.plan_year)) rep.yearMismatchRows++;
    }
  }
  return rep;
}

export type Verdict = { ok: boolean; blockers: string[]; notes: string[] };

/** 7단계 데이터 정리를 진행해도 되는지 요약 */
export function judge(rep: Report): Verdict {
  const blockers: string[] = [];
  const notes: string[] = [];
  if (rep.displayedOnlyInNote.actions > 0) {
    blockers.push(
      `표에 행이 없는 항목의 note 연결이 ${rep.displayedOnlyInNote.actions}개 항목(연결 ${rep.displayedOnlyInNote.linked}건, 제외 ${rep.displayedOnlyInNote.excluded}건)에 있습니다. ` +
        `지금 화면에는 보이지만 정리하면 사라집니다. 항목별로 유지할지(표에 넣기) 버릴지 결정이 필요합니다.`,
    );
  }
  if (rep.roundTrip.notIdentical > 0) {
    blockers.push(
      `분해→조립 시 원본과 달라지는 note 가 ${rep.roundTrip.notIdentical}건(다시 조립해도 안정되지 않는 것 ${rep.roundTrip.notStable}건)입니다. ` +
        `일괄 정리 전에 원인(JSON 서식 차이, 인식하지 못하는 구간)을 확인해야 합니다.`,
    );
  }
  if (rep.ignoredNoteOnly.linked + rep.ignoredNoteOnly.excluded > 0) {
    notes.push(`표에 행이 있는 항목의 note 에만 있는 옛 연결 ${rep.ignoredNoteOnly.linked + rep.ignoredNoteOnly.excluded}건: 지금도 안 보이니 정리해도 화면 변화는 없습니다. 기존 백필 스크립트를 그대로 다시 돌리면 이 연결이 다시 보이게 되므로 돌리지 마세요.`);
  }
  if (rep.orphanTableRows > 0) notes.push(`항목이 note 에 없는 표 행 ${rep.orphanTableRows}건(계획서 재추출 등으로 생긴 고아). 7단계와 무관, 필요하면 따로 정리.`);
  if (rep.yearMismatchRows > 0) notes.push(`연도가 어긋난 표 행 ${rep.yearMismatchRows}건: 연도별 화면에서 안 보일 수 있습니다.`);
  if (rep.danglingTableRows > 0) notes.push(`연결 대상(상담기록·제공이력)이 이미 삭제된 표 행 ${rep.danglingTableRows}건. 화면에는 영향 없음.`);
  if (rep.duplicateActionIds > 0) notes.push(`같은 항목 ID 가 여러 계획서에 나타나는 경우 ${rep.duplicateActionIds}건.`);
  return { ok: blockers.length === 0, blockers, notes };
}
