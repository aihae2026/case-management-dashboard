/**
 * note JSON 분리 7단계 사전 점검 (읽기 전용 — DB 를 절대 수정하지 않음)
 *
 * 사용법 (PowerShell, 프로젝트 폴더에서):
 *   $env:SUPABASE_URL="https://xxxx.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY="(service_role 키)"
 *   bun scripts/precheck-note-links.ts
 *
 * 하는 일(전부 select 만 사용)
 *  - clients(id, org_id, client_code, note), care_plan_action_links, activity_logs(id), provisions(id)를 읽는다.
 *  - 7단계로 note 의 연결 필드를 지우면 화면에서 사라지는 연결이 있는지, note 를 다시 쓰는 것이 안전한지 점검한다.
 *
 * 개인정보 보호: 출력에는 건수·대상자 번호(JN0001)·항목 ID 앞 8자리만 나옵니다. 이름·상담 내용·note 는 출력하지 않습니다.
 * 이 스크립트의 결과 화면을 그대로 복사해서 전달하시면 됩니다(키는 출력되지 않습니다).
 */
import { createClient } from "@supabase/supabase-js";
import { analyze, judge, type ClientInput, type LinkRowInput } from "./note-links-analysis";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("❌ 환경변수 SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 를 설정해 주세요(설정 방법은 이 파일 맨 위 설명 참고).");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** id 순으로 끝까지 페이지 단위로 읽는다(서버 기본 1000행 제한 대응). 오류가 나면 중단한다. */
async function readAll<T>(table: string, columns: string, page: number): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await sb.from(table).select(columns).order("id", { ascending: true }).range(from, from + page - 1);
    if (error) {
      console.error(`❌ ${table} 조회 실패: ${error.message}`);
      process.exit(1);
    }
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

console.log("\n🔍 note JSON 분리 7단계 사전 점검 (읽기 전용)\n");

const clients = await readAll<ClientInput>("clients", "id, org_id, client_code, note", 200);
const links = await readAll<LinkRowInput>("care_plan_action_links", "client_id, plan_year, action_id, link_type, linked_id, excluded, id", 1000);
const logs = await readAll<{ id: string }>("activity_logs", "id", 1000);
const provs = await readAll<{ id: string }>("provisions", "id", 1000);

const rep = analyze({
  clients,
  links,
  logIds: new Set(logs.map((l) => l.id)),
  provIds: new Set(provs.map((p) => p.id)),
});

const line = (s = "") => console.log(s);
line(`대상자 ${rep.clients}명 / 표(care_plan_action_links) ${rep.tableLinkCounts.linked + rep.tableLinkCounts.excluded}행(연결 ${rep.tableLinkCounts.linked}, 제외 ${rep.tableLinkCounts.excluded}) / 상담기록 ${logs.length}건 / 제공이력 ${provs.length}건`);
line(`note 안에 연결 필드가 남아 있는 대상자: ${rep.clientsWithNoteLinks}명 (연결 ${rep.noteLinkCounts.linked}건, 제외 ${rep.noteLinkCounts.excluded}건)`);
line();
line("① 정리하면 화면에서 사라지는 연결 (표에 행이 없는 항목의 note 연결)");
line(`   항목 ${rep.displayedOnlyInNote.actions}개 · 연결 ${rep.displayedOnlyInNote.linked}건 · 제외 ${rep.displayedOnlyInNote.excluded}건`);
for (const e of rep.displayedOnlyInNote.examples) {
  line(`   - ${e.client}  항목 ${e.action}…  ${e.year}년  상담 ${e.logs} · 제공 ${e.provs} · 제외 ${e.excludedCount}`);
}
if (rep.displayedOnlyInNote.actions > rep.displayedOnlyInNote.examples.length) {
  line(`   … 외 ${rep.displayedOnlyInNote.actions - rep.displayedOnlyInNote.examples.length}개 항목`);
}
line();
line("② 지금도 안 보이는 옛 연결 (표에 행이 있는 항목의 note 에만 있는 연결)");
line(`   연결 ${rep.ignoredNoteOnly.linked}건 · 제외 ${rep.ignoredNoteOnly.excluded}건 → 정리해도 화면 변화 없음`);
line();
line("③ 표 쪽 상태");
line(`   고아 행(항목이 note 에 없음): ${rep.orphanTableRows}건`);
line(`   연도 어긋난 행: ${rep.yearMismatchRows}건`);
line(`   삭제된 상담기록·제공이력을 가리키는 행: ${rep.danglingTableRows}건`);
line(`   같은 항목 ID 가 여러 계획서에 나타나는 경우: ${rep.duplicateActionIds}건`);
line();
line("⑤ note 에 연결 필드가 남은 대상자 (정리 대상, 마지막 연결 해제 시험 후보)");
line("   '표 연결 1개 항목'이 있는 대상자가 시험에 가장 알맞습니다(그 연결을 해제하면 항목의 표 행이 0개가 됩니다).");
for (const c of [...rep.noteLinkClients].sort((a, b) => b.singleLinkActions - a.singleLinkActions || b.actions - a.actions)) {
  line(`   - ${c.client}  연결 있는 항목 ${c.actions}개 · 표 연결 1개짜리 항목 ${c.singleLinkActions}개`);
}
line();
line("④ note 를 분해→조립해서 다시 쓰는 것이 안전한지");
line(`   원본과 달라지는 note: ${rep.roundTrip.notIdentical}건 (다시 조립해도 안정되지 않는 것 ${rep.roundTrip.notStable}건)`);
if (rep.roundTrip.examples.length > 0) line(`   해당 대상자 번호(최대 10명): ${rep.roundTrip.examples.join(", ")}`);
line();

const v = judge(rep);
line(v.ok ? "✅ 판정: 7단계 데이터 정리를 진행해도 되는 상태입니다." : "🟡 판정: 정리 전에 확인할 것이 있습니다.");
for (const b of v.blockers) line(`   ⛔ ${b}`);
for (const n of v.notes) line(`   ℹ️ ${n}`);
line("\n(이 점검은 DB 를 변경하지 않았습니다.)\n");
