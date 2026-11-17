// 담당자 인수인계 함수 시험: 운영과 같은 규칙을 흉내 낸 임시 DB(PGlite)에서 handover_clients 를 검증한다.
// 실행: 임시 폴더에서 `bun add @electric-sql/pglite` 후, 이 파일 위치에서 `bun handover_test.ts` (프로젝트 의존성에는 추가하지 않음)
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)) + "/";
const db = new PGlite();
const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const A = u(1), M = u(2), P = u(3), V = u(4), N = u(5), Y = u(6), Z = u(7), E = u(8); // E: 이름이 비어 있는 구성원
const O1 = u(101), O2 = u(102);
const c1 = u(201), c2 = u(202), c3 = u(203), c4 = u(204), c5 = u(205), d1 = u(301);

let pass = 0, fail = 0;
const results: string[] = [];
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++; else fail++;
  results.push(`${cond ? "✅" : "❌"} ${name}${extra ? "  → " + extra : ""}`);
}

async function run(uid: string | null, sql: string, role = "authenticated") {
  if (uid) await db.exec(`select set_config('request.jwt.claim.sub','${uid}',false)`);
  await db.exec(`set role ${role}`);
  try {
    const r = await db.query(sql);
    return { ok: true as const, rows: r.rows as any[], err: "" };
  } catch (e: any) {
    return { ok: false as const, rows: [] as any[], err: String(e.message) };
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false)`);
  }
}
const sup = async (sql: string) => (await db.query(sql)).rows as any[];
const ho = (uid: string | null, from: string, to: string | null, ids: string[], role = "authenticated") =>
  run(uid, `select public.handover_clients('${from}', ${to ? `'${to}'` : "null"}::uuid, array[${ids.map((i) => `'${i}'`).join(",")}]::uuid[], null) as r`, role);
const workerOf = async (id: string) => (await sup(`select worker_name from public.clients where id='${id}'`))[0]?.worker_name as string | null;

// ── 운영과 같은 시험용 DB ───────────────────────────────────────────────
await db.exec(readFileSync(HERE + "../approval-gate/test/prod_like.sql", "utf8"));
await db.exec(`
  alter table public.clients add column worker_name text, add column updated_at timestamptz default now();
  create table public.activity_logs(id uuid primary key default gen_random_uuid(), client_id uuid, org_id uuid, worker_name text, note text);
`);
await db.exec(`insert into auth.users select unnest(array['${[A, M, P, V, N, Y, Z, E].join("','")}']::uuid[])`);
await db.exec(`
  insert into public.organizations(id,name,slug,join_code,created_by) values
   ('${O1}','기관1','org1','CODE1','${A}'), ('${O2}','기관2','org2','CODE2','${Y}');
  insert into public.profiles(id,org_id,name,email,status) values
   ('${A}','${O1}','관리자A','a@x','approved'),
   ('${M}','${O1}','김철수','m@x','approved'),
   ('${P}','${O1}','대기P','p@x','pending'),
   ('${V}','${O1}','뷰어V','v@x','approved'),
   ('${N}','${O1}','일반N','n@x','approved'),
   ('${E}','${O1}','  ','e@x','approved'),
   ('${Y}','${O2}','관리자Y','y@x','approved'),
   ('${Z}','${O2}','타기관Z','z@x','approved');
  update public.user_roles set role='viewer' where user_id='${V}';
`);
await db.exec(readFileSync(HERE + "../migrations/20261024000000_worker_handover.sql", "utf8"));
await db.exec(`
  insert into public.clients(id,org_id,name,worker_name) values
   ('${c1}','${O1}','대상1','홍길동'), ('${c2}','${O1}','대상2','홍길동'), ('${c3}','${O1}','대상3',' 홍길동 '),
   ('${c4}','${O1}','대상4','김철수'), ('${c5}','${O1}','대상5','홍길동'), ('${d1}','${O2}','타기관대상','홍길동');
  insert into public.activity_logs(client_id,org_id,worker_name,note) values
   ('${c1}','${O1}','홍길동','상담1'), ('${c2}','${O1}','홍길동','상담2'), ('${c3}','${O1}','홍길동','상담3');
`);
const roleOf = async (id: string) => (await sup(`select role from public.user_roles where user_id='${id}'`)).map((r) => r.role).join(",");
check("시험 준비: 관리자 A 는 admin, 구성원 M 은 member, 뷰어 V 는 viewer",
  (await roleOf(A)) === "admin" && (await roleOf(M)) === "member" && (await roleOf(V)) === "viewer");

// ── 권한 ───────────────────────────────────────────────────────────────
let r = await ho(M, "홍길동", M, [c1]);
check("일반 구성원은 인수인계할 수 없다", !r.ok && /관리자만/.test(r.err), r.err);
r = await ho(P, "홍길동", M, [c1]);
check("승인 대기 계정은 인수인계할 수 없다", !r.ok, r.err);
r = await ho(null, "홍길동", M, [c1]);
check("로그인하지 않으면 인수인계할 수 없다", !r.ok && /로그인/.test(r.err), r.err);
r = await ho(A, "홍길동", M, [c1], "anon");
check("anon 은 함수를 실행할 수 없다", !r.ok, r.err);
check("권한 실패 뒤 대상자 담당은 그대로", (await workerOf(c1)) === "홍길동");

// ── 새 담당자는 같은 기관의 승인된 구성원만 ────────────────────────────
r = await ho(A, "홍길동", P, [c1]);
check("승인 대기 계정은 새 담당자가 될 수 없다", !r.ok && /승인된 구성원/.test(r.err), r.err);
r = await ho(A, "홍길동", V, [c1]);
check("읽기 전용(뷰어) 계정은 새 담당자가 될 수 없다", !r.ok && /승인된 구성원/.test(r.err), r.err);
r = await ho(A, "홍길동", Z, [c1]);
check("다른 기관 구성원은 새 담당자가 될 수 없다", !r.ok && /승인된 구성원/.test(r.err), r.err);
r = await ho(A, "홍길동", E, [c1]);
check("이름이 비어 있는 계정은 새 담당자가 될 수 없다", !r.ok, r.err);
r = await ho(A, "홍길동", u(999), [c1]);
check("존재하지 않는 계정은 새 담당자가 될 수 없다", !r.ok, r.err);
r = await ho(A, "홍길동", null, [c1]);
check("새 담당자를 비우면 거절", !r.ok, r.err);
r = await ho(A, "김철수", M, [c4]);
check("이전·새 담당자가 같으면 거절", !r.ok && /같습니다/.test(r.err), r.err);
r = await ho(A, "", M, [c1]);
check("이전 담당자를 비우면 거절", !r.ok, r.err);
r = await ho(A, "홍길동", M, []);
check("대상자를 고르지 않으면 거절", !r.ok, r.err);
check("거절된 요청은 아무것도 바꾸지 않는다", (await workerOf(c1)) === "홍길동" && (await sup(`select 1 from public.worker_handovers`)).length === 0);

// ── 정상 인수인계 ──────────────────────────────────────────────────────
r = await ho(A, "홍길동", M, [c1, c2]);
check("관리자 A: 홍길동 → 김철수 (2명) 성공", r.ok && r.rows[0].r.moved === 2 && r.rows[0].r.skipped === 0 && r.rows[0].r.to_name === "김철수", JSON.stringify(r.rows[0]?.r ?? r.err));
check("선택한 대상자의 담당이 새 담당자 이름으로 바뀐다", (await workerOf(c1)) === "김철수" && (await workerOf(c2)) === "김철수");
check("선택하지 않은 대상자는 그대로", (await workerOf(c3)) === " 홍길동 ");
const logsAfter = await sup(`select worker_name from public.activity_logs order by note`);
check("이전 담당자가 쓴 상담기록의 작성자 이름은 그대로 보존된다", logsAfter.length === 3 && logsAfter.every((l) => l.worker_name === "홍길동"), JSON.stringify(logsAfter));
const hist = await sup(`select from_name,to_name,moved_count,skipped_count,performed_by_name from public.worker_handovers`);
check("인수인계 이력이 한 건 남는다", hist.length === 1 && hist[0].from_name === "홍길동" && hist[0].to_name === "김철수" && hist[0].moved_count === 2 && hist[0].performed_by_name === "관리자A", JSON.stringify(hist));

// ── 건너뛰는 경우 ──────────────────────────────────────────────────────
r = await ho(A, "홍길동", M, [c3, d1, c4]);
check("앞뒤 공백이 있는 담당자 이름도 옮기고, 다른 기관·이미 바뀐 대상자는 건너뛴다", r.ok && r.rows[0].r.moved === 1 && r.rows[0].r.skipped === 2, JSON.stringify(r.rows[0]?.r ?? r.err));
check("다른 기관 대상자는 바뀌지 않는다", (await workerOf(d1)) === "홍길동");
check("이미 다른 담당자였던 대상자는 바뀌지 않는다", (await workerOf(c4)) === "김철수");
r = await ho(A, "홍길동", M, [c1]);
check("이미 담당이 바뀐 대상자만 고르면 거절(옮길 대상자 없음)", !r.ok && /옮길 대상자가 없습니다/.test(r.err), r.err);
r = await ho(Y, "홍길동", Z, [c5, d1]);
check("다른 기관 관리자가 내 기관 대상자를 섞어 보내도 자기 기관 것만 바뀐다", r.ok && r.rows[0].r.moved === 1 && (await workerOf(d1)) === "타기관Z" && (await workerOf(c5)) === "홍길동", JSON.stringify(r.rows[0]?.r ?? r.err));

// ── 이력 열람·변조 방지 ────────────────────────────────────────────────
r = await run(N, `select count(*)::int as n from public.worker_handovers`);
check("같은 기관 구성원은 이력을 읽을 수 있다(자기 기관 2건)", r.ok && r.rows[0].n === 2, JSON.stringify(r.rows));
r = await run(Z, `select count(*)::int as n from public.worker_handovers`);
check("다른 기관 구성원은 우리 기관 이력을 볼 수 없다(자기 기관 1건만)", r.ok && r.rows[0].n === 1, JSON.stringify(r.rows));
r = await run(A, `insert into public.worker_handovers(org_id,from_name,to_name,moved_count) values ('${O1}','a','b',1)`);
check("관리자도 이력을 직접 추가할 수 없다", !r.ok, r.err);
r = await run(A, `update public.worker_handovers set to_name='x'`);
check("이력을 수정할 수 없다", !r.ok, r.err);
r = await run(A, `delete from public.worker_handovers`);
check("이력을 삭제할 수 없다", !r.ok, r.err);

console.log(results.join("\n"));
console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
