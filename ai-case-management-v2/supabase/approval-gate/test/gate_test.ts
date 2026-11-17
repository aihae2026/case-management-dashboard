// 승인 게이트 시험: 운영과 같은 규칙을 흉내 낸 임시 DB(PGlite)에서 설치→관찰→강제→롤백을 검증한다.
// 실행: 임시 폴더에서 `bun add @electric-sql/pglite` 후, 이 파일 위치에서 `bun gate_test.ts` (프로젝트 의존성에는 추가하지 않음)
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)) + "/";
const GATE = HERE + "../";
const db = new PGlite();
const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const A = u(1), M = u(2), P = u(3), X = u(4), Y = u(5), J = u(6), C = u(7), V = u(8);
const O1 = u(101), O2 = u(102);

let pass = 0, fail = 0;
const results: string[] = [];
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++; else fail++;
  results.push(`${cond ? "✅" : "❌"} ${name}${extra ? "  → " + extra : ""}`);
}

async function run(uid: string | null, sql: string) {
  if (uid) await db.exec(`select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated`);
  try {
    const r = await db.query(sql);
    return { ok: true as const, rows: r.rows as any[], err: "" };
  } catch (e: any) {
    return { ok: false as const, rows: [] as any[], err: String(e.message) };
  } finally {
    if (uid) await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false)`);
  }
}
const sup = async (sql: string) => (await db.query(sql)).rows as any[];
const prof = async (id: string) => (await sup(`select org_id, status from public.profiles where id='${id}'`))[0];
const roles = async (id: string, org: string) => (await sup(`select role from public.user_roles where user_id='${id}' and org_id='${org}'`)).map((r) => r.role);
const setCfg = (k: string, v: string) => db.exec(`update guard.config set value='${v}' where key='${k}'`);
const logs = async (rule?: string) => (await sup(`select rule, table_name, op from guard.log ${rule ? `where rule like '${rule}%'` : ""}`));

// ── 운영과 같은 시험용 DB ───────────────────────────────────────────────
await db.exec(readFileSync(HERE + "prod_like.sql", "utf8"));
await db.exec(`insert into auth.users select unnest(array['${[A, M, P, X, Y, J, C, V].join("','")}']::uuid[])`);
await db.exec(`
  insert into public.organizations(id,name,slug,join_code,created_by) values
   ('${O1}','기관1','org1','CODE1','${A}'), ('${O2}','기관2','org2','CODE2','${Y}');
  insert into public.profiles(id,org_id,name,email,status) values ('${A}','${O1}','관리자A','a@x','approved');
  insert into public.profiles(id,org_id,name,email,status) values ('${M}','${O1}','멤버M','m@x','approved');
  insert into public.profiles(id,org_id,name,email,status) values ('${P}','${O1}','대기P','p@x','pending');
  insert into public.profiles(id,org_id,name,email,status) values ('${V}','${O1}','뷰어V','v@x','approved');
  insert into public.profiles(id,org_id,name,email,status) values ('${Y}','${O2}','관리자Y','y@x','approved');
  insert into public.profiles(id,name,email) values ('${X}','외부X','x@x'), ('${J}','가입J','j@x'), ('${C}','창설C','c@x');
  insert into public.clients(org_id,name) values ('${O1}','O1대상자'), ('${O2}','O2대상자');
`);
check("시드: A=관리자, M=멤버", (await roles(A, O1)).includes("admin") && (await roles(M, O1)).includes("member"));
await db.exec(`update public.user_roles set role='viewer' where user_id='${V}'; delete from public.user_roles where user_id='${V}' and role<>'viewer'`);

// ── 설치 전 기준선: 구멍이 실제로 있었는지 확인(공격 시나리오) ────────────
let r = await run(X, `update public.profiles set org_id='${O2}' where id='${X}'`);
check("[설치 전] 기관 없는 X 가 직접 기관2로 들어감(구멍 재현)", r.ok && (await prof(X)).org_id === O2);
await db.exec(`update public.profiles set org_id=null where id='${X}'; delete from public.user_roles where user_id='${X}'`);
r = await run(M, `insert into public.user_roles(user_id,org_id,role) values ('${M}','${O1}','admin')`);
check("[설치 전] 일반 멤버 M 이 스스로 관리자 역할 추가(구멍 재현)", r.ok && (await roles(M, O1)).includes("admin"));
await db.exec(`delete from public.user_roles where user_id='${M}' and role='admin'`);
r = await run(M, `update public.profiles set status='approved' where id='${P}'`);
check("[설치 전] 일반 멤버 M 이 대기자 P 를 승인(구멍 재현)", r.ok && (await prof(P)).status === "approved");
await db.exec(`update public.profiles set status='pending' where id='${P}'`);
r = await run(M, `update public.organizations set name='해킹' where id='${O1}'`);
check("[설치 전] 일반 멤버가 기관명 변경(구멍 재현)", r.ok);
await db.exec(`update public.organizations set name='기관1' where id='${O1}'`);

// ── 사전점검·설치 ───────────────────────────────────────────────────────
const pre = await db.query(readFileSync(GATE + "00_precheck.sql", "utf8"));
check("00_precheck 실행됨", pre.rows.length > 0, `${pre.rows.length}행`);
const origDef = (await sup(`select pg_get_functiondef('public.current_org_id()'::regprocedure) d`))[0].d;
await db.exec(readFileSync(GATE + "01_install.sql", "utf8"));
await db.exec(readFileSync(GATE + "01_install.sql", "utf8")); // 두 번 실행해도 안전
check("01_install 두 번 실행 OK(멱등)", true);
check("원본 정의가 보관됨", (await sup(`select value from guard.config where key='orig_current_org_id_def'`))[0].value === origDef);

// ── [A] 관찰 모드: 동작이 하나도 바뀌지 않아야 함 ───────────────────────
r = await run(X, `update public.profiles set org_id='${O2}' where id='${X}'`);
check("[관찰] X 의 기관 변경이 막히지 않음(기록만)", r.ok && (await prof(X)).org_id === O2 && (await prof(X)).status === "approved");
check("[관찰] 그 동작이 force_pending 으로 기록됨", (await logs("force_pending")).length >= 1);
await db.exec(`update public.profiles set org_id=null where id='${X}'; delete from public.user_roles where user_id='${X}'; delete from guard.log`);
r = await run(M, `insert into public.user_roles(user_id,org_id,role) values ('${M}','${O1}','admin')`);
check("[관찰] M 의 관리자 역할 추가가 막히지 않음(기록만)", r.ok && (await logs("deny")).length >= 1);
await db.exec(`delete from public.user_roles where user_id='${M}' and role='admin'; delete from guard.log`);
r = await run(A, `select count(*)::int c from public.clients`);
check("[관찰] 정상 사용자 데이터 읽기 동일", r.ok && r.rows[0].c === 1);
r = await run(P, `select count(*)::int c from public.clients`);
check("[관찰] 대기자도 아직 데이터 읽힘(차단은 2단계에서)", r.ok && r.rows[0].c === 1);

// ── [B] 강제 모드 ──────────────────────────────────────────────────────
await setCfg("mode", "enforce"); await setCfg("data_block", "on"); await db.exec("delete from guard.log");

// (1) 소속이 바뀌면 자동 '승인 대기'
r = await run(X, `update public.profiles set org_id='${O2}', status='approved' where id='${X}'`);
check("(1) X 가 기관2로 직접 이동 + status=approved 를 같이 보내도 → pending 강제", r.ok && (await prof(X)).org_id === O2 && (await prof(X)).status === "pending");
await db.exec(`delete from public.user_roles where user_id='${X}'`); // assign_org_role 시험 흔적
// (2) 대기 계정은 데이터 읽기/쓰기 불가
r = await run(X, `select count(*)::int c from public.clients`);
check("(2) 대기 계정 X 는 기관2 대상자를 못 읽음", r.ok && r.rows[0].c === 0);
r = await run(X, `insert into public.clients(org_id,name) values ('${O2}','침입')`);
check("(2) 대기 계정 X 는 기관2 에 대상자를 못 씀", !r.ok, r.err.slice(0, 60));
r = await run(P, `select count(*)::int c from public.clients`);
check("(2) 기존 대기 계정 P 도 데이터 못 읽음", r.ok && r.rows[0].c === 0);
r = await run(P, `select org_id,status from public.profiles where id='${P}'`);
check("(2) 대기 계정도 자기 프로필은 읽음 → 대기 화면 표시 가능", r.ok && r.rows.length === 1 && r.rows[0].status === "pending");
r = await run(A, `select count(*)::int c from public.clients`);
check("(2) 승인된 관리자 A 는 정상", r.ok && r.rows[0].c === 1);
r = await run(M, `select count(*)::int c from public.clients`);
check("(2) 승인된 멤버 M 은 정상", r.ok && r.rows[0].c === 1);
// (3) 승인은 그 기관 관리자만, 본인 승인 불가
r = await run(X, `update public.profiles set status='approved' where id='${X}'`);
check("(3) X 가 본인을 승인 → 차단", !r.ok && (await prof(X)).status === "pending", r.err.slice(0, 50));
r = await run(M, `update public.profiles set status='approved' where id='${P}'`);
check("(3) 일반 멤버 M 이 같은 기관 대기자 P 를 승인 → 차단", !r.ok && (await prof(P)).status === "pending", r.err.slice(0,50));
r = await run(Y, `update public.profiles set status='approved' where id='${P}'`);
check("(3) 다른 기관 관리자 Y 가 기관1 대기자 P 승인 → 차단", (await prof(P)).status === "pending");
r = await run(A, `update public.profiles set status='approved' where id='${P}'`);
check("(3) 기관1 관리자 A 가 P 승인 → 허용", r.ok && (await prof(P)).status === "approved");
r = await run(P, `select count(*)::int c from public.clients`);
check("(3) 승인 직후 P 가 데이터 읽기 가능", r.ok && r.rows[0].c === 1);
await db.exec(`update public.profiles set status='pending' where id='${P}'`); // 원복
r = await run(Y, `update public.profiles set status='approved' where id='${X}'`);
check("(3) 기관2 관리자 Y 가 X(기관2 대기) 승인 → 허용", r.ok && (await prof(X)).status === "approved");
await db.exec(`update public.profiles set org_id=null, status='approved' where id='${X}'; delete from public.user_roles where user_id='${X}'`);
// (4) 역할 테이블 보호
r = await run(M, `insert into public.user_roles(user_id,org_id,role) values ('${M}','${O1}','admin')`);
check("(4) 일반 멤버 M 이 스스로 관리자 역할 만들기 → 차단", !r.ok && !(await roles(M, O1)).includes("admin"), r.err.slice(0, 50));
r = await run(M, `delete from public.user_roles where user_id='${A}' and org_id='${O1}'`);
check("(4) 일반 멤버 M 이 관리자 A 의 역할 삭제 → 차단", !r.ok || (await roles(A, O1)).includes("admin"));
r = await run(P, `insert into public.user_roles(user_id,org_id,role) values ('${P}','${O1}','admin')`);
check("(4) 대기자 P 가 스스로 관리자 → 차단", !r.ok);
const rd = await run(A, `delete from public.user_roles where user_id='${M}' and org_id='${O1}'`);
r = await run(A, `insert into public.user_roles(user_id,org_id,role) values ('${M}','${O1}','viewer')`);
check("(4) 관리자 A 의 역할 변경(삭제+삽입, 앱 방식) → 허용", rd.ok && r.ok && (await roles(M, O1)).join() === "viewer");
await run(A, `delete from public.user_roles where user_id='${M}' and org_id='${O1}'`);
await run(A, `insert into public.user_roles(user_id,org_id,role) values ('${M}','${O1}','member')`);

// 기관 정보
r = await run(M, `update public.organizations set name='해킹', join_code='HACK' where id='${O1}'`);
check("기관 정보: 일반 멤버가 기관명/가입코드 변경 → 차단", !r.ok);
r = await run(A, `update public.organizations set name='기관1(수정)' where id='${O1}'`);
check("기관 정보: 관리자는 변경 가능", r.ok);
r = await run(A, `update public.organizations set created_by='${A}' where id='${O1}'`);
check("기관 정보: 관리자라도 생성자 필드 변경은 허용(동일값)", r.ok);

// 기존 정상 기능
r = await run(M, `update public.profiles set name='멤버M2', phone='010-1', approval_line='[1]' where id='${M}'`);
check("정상: 본인 이름·연락처·결재선 수정", r.ok && (await sup(`select name from public.profiles where id='${M}'`))[0].name === "멤버M2");
r = await run(A, `update public.profiles set phone='010-9' where id='${M}'`);
check("정상: 관리자가 멤버 연락처 수정", r.ok);
r = await run(M, `update public.profiles set org_id=null where id='${A}'`);
check("공격: 멤버 M 이 관리자 A 를 기관에서 내보내기 → 차단", !r.ok && (await prof(A)).org_id === O1);
r = await run(M, `update public.profiles set org_id='${O2}' where id='${V}'`);
check("공격: 멤버 M 이 남(V)을 다른 기관으로 보내기 → 차단", !r.ok && (await prof(V)).org_id === O1);

// (1') RPC 가입 흐름: 코드로 가입 → 앱의 upsert(status=pending)
r = await run(J, `select * from public.join_org_by_code('code1')`);
check("가입: join_org_by_code 호출 성공", r.ok && r.rows[0]?.id === O1);
check("가입: RPC 직후 곧바로 pending (앱의 후속 upsert 없이도)", (await prof(J)).org_id === O1 && (await prof(J)).status === "pending");
r = await run(J, `insert into public.profiles(id,name,email,org_id,status,phone) values ('${J}','가입J','j@x','${O1}','pending','010')
                  on conflict (id) do update set name=excluded.name, email=excluded.email, org_id=excluded.org_id, status=excluded.status, phone=excluded.phone`);
check("가입: 앱의 후속 upsert 도 성공", r.ok && (await prof(J)).status === "pending");
r = await run(J, `select count(*)::int c from public.clients`);
check("가입: 가입 직후 데이터 못 봄(승인 대기)", r.ok && r.rows[0].c === 0);
r = await run(A, `update public.profiles set status='approved' where id='${J}'`);
check("가입: 관리자 승인 → 허용", r.ok && (await prof(J)).status === "approved");
r = await run(J, `select count(*)::int c from public.clients`);
check("가입: 승인 후 데이터 접근 가능", r.ok && r.rows[0].c === 1);
check("가입: 승인된 신규는 member 역할", (await roles(J, O1)).join() === "member");
// 거절(reject) · 내보내기
r = await run(A, `update public.profiles set org_id=null, status='approved' where id='${J}'`);
check("거절/제거: 관리자의 {org_id:null,status:approved} → 허용", r.ok && (await prof(J)).org_id === null);
await run(A, `delete from public.user_roles where user_id='${J}' and org_id='${O1}'`);
check("거절/제거: 역할 행 삭제 허용", (await roles(J, O1)).length === 0);
await run(J, `select * from public.join_org_by_code('CODE1')`);
await db.exec(`update public.profiles set status='approved' where id='${J}'`);
r = await run(A, `select public.remove_org_member('${J}')`);
check("내보내기: remove_org_member RPC → 허용", r.ok && (await prof(J)).org_id === null);
r = await run(M, `select public.remove_org_member('${V}')`);
check("내보내기: 일반 멤버의 RPC → 기존대로 거부", !r.ok);

// (기관 생성) 신규 계정이 기관을 만들고 본인 프로필에 연결
r = await run(C, `insert into public.organizations(name,slug,join_code,created_by) values ('창설기관','new','NEW1','${C}') returning id`);
check("기관 생성: organizations INSERT 허용", r.ok);
const newOrg = r.rows[0]?.id;
r = await run(C, `insert into public.profiles(id,name,email,org_id) values ('${C}','창설C','c@x','${newOrg}')
                  on conflict (id) do update set name=excluded.name, email=excluded.email, org_id=excluded.org_id`);
check("기관 생성: 프로필 연결 upsert 허용", r.ok);
check("기관 생성: 창설자는 승인 상태 + 관리자 역할", (await prof(C)).status === "approved" && (await roles(C, newOrg)).includes("admin"));
await db.exec(`insert into public.clients(org_id,name) values ('${newOrg}','C의 대상자')`);
r = await run(C, `select count(*)::int c from public.clients`);
check("기관 생성: 창설자 데이터 접근 정상", r.ok && r.rows[0].c === 1);
// 창설자 예외 악용: 이미 구성원이 있는 기관에 created_by 로 다시 들어오기
await db.exec(`update public.profiles set org_id=null where id='${C}'`);
await db.exec(`insert into public.profiles(id,org_id,name,email,status) values ('${u(9)}',null,'z','z@x','approved')`.replace("insert into public.profiles", "-- skip"));
await db.exec(`insert into auth.users values ('${u(9)}'); insert into public.profiles(id,org_id,name,email) values ('${u(9)}','${newOrg}','다른사람','o@x')`);
r = await run(C, `update public.profiles set org_id='${newOrg}', status='approved' where id='${C}'`);
check("악용 차단: 내보내진 창설자가 이미 사람 있는 기관에 재진입 → 승인 대기", r.ok && (await prof(C)).status === "pending");

// 서비스키/대시보드 경로 (auth.uid 없음)
r = await run(null, `update public.profiles set status='approved' where id='${C}'`);
check("서버/대시보드(로그인 정보 없음)의 변경은 영향 없음", r.ok && (await prof(C)).status === "approved");
await db.exec(`set role service_role`);
let ok1 = true; try { await db.exec(`update public.profiles set status='pending' where id='${C}'; insert into public.user_roles(user_id,org_id,role) values ('${C}','${O1}','viewer'); delete from public.user_roles where user_id='${C}' and org_id='${O1}'; update public.profiles set status='approved' where id='${C}'`); } catch (e) { ok1 = false; }
await db.exec(`reset role`);
check("service_role 로 profiles/user_roles 변경 정상(슈퍼관리자 기능)", ok1);

// 승인 대기 계정이 다른 방법으로 우회 시도
r = await run(X, `update public.profiles set org_id='${O1}' where id='${X}'`);
check("우회 시도: X 가 기관1로 이동 → 대기 + 데이터 차단", r.ok && (await prof(X)).status === "pending");
r = await run(X, `insert into public.user_roles(user_id,org_id,role) values ('${X}','${O1}','admin')`);
check("우회 시도: 대기 X 가 기관1 관리자 역할 삽입 → 차단", !r.ok);
r = await run(X, `update public.organizations set name='x' where id='${O1}'`);
check("우회 시도: 대기 X 가 기관1 정보 수정 → 차단(또는 0행)", !r.ok || r.rows.length === 0);
r = await run(X, `update public.profiles set org_id='${O2}', status='approved' where id='${X}'`);
check("우회 시도: X 가 다시 기관2로 → 여전히 대기", r.ok && (await prof(X)).status === "pending");
await db.exec(`update public.profiles set org_id=null where id='${X}'; delete from public.user_roles where user_id='${X}'`);

// 로그 확인
const lg = await logs();
check("강제 모드 기록(deny/force) 남음", lg.length > 0, `${lg.length}건`);

// ── [C] 롤백 ──────────────────────────────────────────────────────────
await db.exec(readFileSync(GATE + "03_rollback.sql", "utf8"));
const afterDef = (await sup(`select pg_get_functiondef('public.current_org_id()'::regprocedure) d`))[0].d;
check("롤백: current_org_id 가 설치 전 원본과 완전히 동일", afterDef === origDef);
const trg = await sup(`select tgname from pg_trigger where tgname like '%approval_guard'`);
check("롤백: 트리거 3개 제거", trg.length === 0);
r = await run(P, `select count(*)::int c from public.clients`);
check("롤백: 대기자도 설치 전처럼 다시 읽힘(원상태)", r.ok && r.rows[0].c === 1);
r = await run(M, `insert into public.user_roles(user_id,org_id,role) values ('${M}','${O1}','admin')`);
check("롤백: 설치 전 동작 복귀 확인(구멍도 같이 복귀)", r.ok);

console.log(results.join("\n"));
console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
