/**
 * DB 백업 복원 스크립트 (google-drive-relay/Code.gs 가 만든 백업 폴더 → Supabase)
 *
 * 기본 동작은 "비교만(dry-run)" 입니다. --apply 와 --confirm-host 를 모두 줘야만 실제로 씁니다.
 *
 * 준비
 *  1) Drive 의 [백업]/backup_날짜 폴더를 통째로 내려받아 압축을 풉니다 (_manifest.json 이 보여야 함).
 *  2) 복원 "대상" 프로젝트의 주소와 service_role 키를 환경변수로 지정합니다 (PowerShell):
 *       $env:SUPABASE_URL="https://대상프로젝트.supabase.co"
 *       $env:SUPABASE_SERVICE_ROLE_KEY="(대상 프로젝트의 service_role 키)"
 *     ⚠ 환경변수가 가리키는 프로젝트가 곧 복원 대상입니다. 운영 프로젝트인지 연습용인지 반드시 확인하세요.
 *  3) 프로젝트를 새로 만든 경우, 먼저 스키마를 적용해야 합니다:  supabase db push  (supabase/migrations)
 *
 * 사용법
 *   bun scripts/restore-from-backup.ts <백업폴더>                       # 비교만 (아무것도 쓰지 않음)
 *   bun scripts/restore-from-backup.ts <백업폴더> --auth --apply --confirm-host <대상호스트>
 *
 * 옵션
 *   --apply                  실제로 씀 (반드시 --confirm-host 와 함께)
 *   --confirm-host <host>    대상 프로젝트 호스트(예: abcd.supabase.co). SUPABASE_URL 의 호스트와 같아야 함
 *   --mode missing|overwrite missing(기본): 없는 행만 추가, 있는 행은 건드리지 않음
 *                            overwrite: 같은 id 의 행을 백업 값으로 덮어씀
 *   --auth                   로그인 사용자(auth_users.json)도 복원 (테이블보다 먼저, 같은 id 로 생성)
 *   --tables a,b,c           지정한 테이블만 복원
 *   --allow-incomplete       _INCOMPLETE 백업도 허용 (받아진 데이터까지만 복원)
 *   --keep-audit-artifacts   복원 때문에 자동으로 생긴 감사 기록을 지우지 않음
 *
 * 복원되지 않는 것: RLS 정책·함수·트리거 정의(마이그레이션/덤프로 복구), Auth 설정(Google 로그인 등),
 *                   엣지 함수 비밀값, Cron 작업. → 복원 연습(DR drill)으로 반드시 사전 점검하세요.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
type ManifestTable = { table: string; status: string; rows: number; expected: number | null; parts: number; note?: string };
type Manifest = { complete: boolean; createdAt: string; tables: ManifestTable[] };
type Http = { status: number; text: string };
type Opts = {
  dir: string;
  apply: boolean;
  confirmHost: string | null;
  mode: "missing" | "overwrite";
  auth: boolean;
  tables: string[] | null;
  allowIncomplete: boolean;
  keepAuditArtifacts: boolean;
};

const BATCH: Record<string, number> = { audit_log: 50, consent_audit_logs: 50, manuals: 50, manual_sources: 50, ai_reports: 100, closure_reports: 100 };
const DEFAULT_BATCH = 200;
const LAST_TABLES = ["access_log", "audit_log"]; // 의존성 없는 로그는 맨 뒤

function parseArgs(argv: string[]): Opts | string {
  const o: Opts = { dir: "", apply: false, confirmHost: null, mode: "missing", auth: false, tables: null, allowIncomplete: false, keepAuditArtifacts: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--auth") o.auth = true;
    else if (a === "--allow-incomplete") o.allowIncomplete = true;
    else if (a === "--keep-audit-artifacts") o.keepAuditArtifacts = true;
    else if (a === "--confirm-host") o.confirmHost = argv[++i] ?? null;
    else if (a === "--mode") {
      const m = argv[++i];
      if (m !== "missing" && m !== "overwrite") return "--mode 는 missing 또는 overwrite 여야 합니다.";
      o.mode = m;
    } else if (a === "--tables") o.tables = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--")) return `알 수 없는 옵션: ${a}`;
    else if (!o.dir) o.dir = a;
    else return `인자가 너무 많습니다: ${a}`;
  }
  if (!o.dir) return "백업 폴더 경로를 지정하세요.  예) bun scripts/restore-from-backup.ts C:\\backup_2026-10-07_02-00";
  return o;
}

export async function run(argv: string[], env: Record<string, string | undefined>, log: (s: string) => void = console.log): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") { log("❌ " + parsed); return 2; }
  const opts = parsed;

  const url = (env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY ?? "";
  if (!url || !key) { log("❌ SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다 (복원 대상 프로젝트)."); return 2; }
  let host: string;
  try { host = new URL(url).host; } catch { log("❌ SUPABASE_URL 형식이 올바르지 않습니다."); return 2; }

  async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Http> {
    const res = await fetch(url + path, {
      method,
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  }

  log(`\n🔁 DB 백업 복원 — ${opts.apply ? "실제 쓰기 모드" : "비교만(dry-run, 아무것도 쓰지 않음)"}`);
  log(`   대상 프로젝트: ${host}`);
  log(`   백업 폴더    : ${opts.dir}`);
  log(`   복원 방식    : ${opts.mode === "missing" ? "없는 행만 추가 (기존 행 유지)" : "같은 id 는 백업 값으로 덮어쓰기"}\n`);

  // ── 1. 백업 폴더 점검 ──────────────────────────────────────────────
  const mfPath = join(opts.dir, "_manifest.json");
  if (!existsSync(mfPath)) { log("❌ _manifest.json 이 없습니다. 백업 폴더 경로가 맞는지, 폴더가 완전히 내려받아졌는지 확인하세요."); return 2; }
  const manifest = JSON.parse(readFileSync(mfPath, "utf8")) as Manifest;
  log(`   백업 시각: ${manifest.createdAt} · 상태: ${manifest.complete ? "정상" : "불완전(INCOMPLETE)"}`);
  if (!manifest.complete && !opts.allowIncomplete) {
    const bad = manifest.tables.filter((t) => ["failed", "partial", "not_run"].includes(t.status));
    log("❌ 불완전한 백업입니다. 문제 테이블: " + bad.map((t) => `${t.table}[${t.status}]`).join(", "));
    log("   받아진 데이터까지만 복원하려면 --allow-incomplete 를 추가하세요.");
    return 2;
  }

  const wanted = (name: string) => !opts.tables || opts.tables.includes(name);
  const files = readdirSync(opts.dir);
  const problems: string[] = [];
  const tableRows = new Map<string, Row[]>();
  let order = manifest.tables.map((t) => t.table).filter((t) => t !== "auth_users");
  order = [...order.filter((t) => !LAST_TABLES.includes(t)), ...LAST_TABLES.filter((t) => order.includes(t))];

  for (const mt of manifest.tables) {
    if (mt.table === "auth_users" || !wanted(mt.table)) continue;
    if (mt.status === "skipped" || mt.status === "not_run") continue;
    if (mt.status !== "ok" && !opts.allowIncomplete) { problems.push(`${mt.table}: 백업 상태가 ${mt.status} 입니다`); continue; }
    const parts = files.filter((f) => f === `${mt.table}.json` || new RegExp(`^${mt.table}_part\\d+\\.json$`).test(f)).sort();
    if (parts.length === 0) { if (mt.rows > 0) problems.push(`${mt.table}: 백업 파일이 없습니다 (매니페스트 ${mt.rows}건)`); continue; }
    let rows: Row[] = [];
    try { for (const f of parts) rows = rows.concat(JSON.parse(readFileSync(join(opts.dir, f), "utf8")) as Row[]); }
    catch (e) { problems.push(`${mt.table}: 파일을 읽지 못했습니다 (${(e as Error).message})`); continue; }
    if (rows.length !== mt.rows) { problems.push(`${mt.table}: 파일 건수 ${rows.length} ≠ 매니페스트 ${mt.rows} (파일 누락/손상?)`); continue; }
    tableRows.set(mt.table, rows);
  }

  // ── 2. 대상 프로젝트 스키마 점검 ────────────────────────────────────
  const spec = await api("GET", "/rest/v1/");
  let targetCols: Record<string, Set<string>> | null = null;
  if (spec.status === 200) {
    try {
      const defs = (JSON.parse(spec.text) as { definitions?: Record<string, { properties?: Record<string, unknown> }> }).definitions ?? {};
      targetCols = {};
      for (const [t, d] of Object.entries(defs)) targetCols[t] = new Set(Object.keys(d.properties ?? {}));
    } catch { targetCols = null; }
  }
  if (!targetCols) log("⚠ 대상 스키마를 읽지 못해 테이블/컬럼 사전 점검을 건너뜁니다.");

  const stripped: { table: string; id: unknown; column: string; value: unknown }[] = [];
  const strippedCols = new Map<string, Set<string>>();
  if (targetCols) {
    for (const [t, rows] of tableRows) {
      const cols = targetCols[t];
      if (!cols) { problems.push(`${t}: 대상 프로젝트에 테이블이 없습니다 → 먼저 스키마(supabase db push)를 적용하세요`); continue; }
      const keys = new Set<string>(); for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
      const unknown = [...keys].filter((k) => !cols.has(k));
      if (unknown.length) strippedCols.set(t, new Set(unknown));
    }
  }
  for (const [t, cols] of strippedCols) log(`⚠ ${t}: 대상에 없는 컬럼 [${[...cols].join(", ")}] 은(는) 복원에서 제외됩니다 (값은 restore_unrestored_columns.json 에 저장)`);

  if (problems.length) {
    log("\n❌ 사전 점검에서 문제가 발견되었습니다. 아무것도 쓰지 않고 중단합니다:");
    problems.forEach((p) => log("   - " + p));
    return 2;
  }

  // ── 3. 현재 대상 상태와 비교 ───────────────────────────────────────
  async function existingIds(table: string): Promise<Set<string> | null> {
    const ids = new Set<string>();
    for (let off = 0; ; off += 1000) {
      const r = await api("GET", `/rest/v1/${table}?select=id&order=id.asc&limit=1000&offset=${off}`);
      if (r.status === 400) return null;                  // id 컬럼이 없는 테이블
      if (r.status !== 200) throw new Error(`${table} 조회 실패 HTTP ${r.status}`);
      const page = JSON.parse(r.text) as { id: unknown }[];
      page.forEach((p) => ids.add(String(p.id)));
      if (page.length < 1000) break;
    }
    return ids;
  }

  log("테이블별 비교 (백업 ↔ 대상 프로젝트 현재 상태)");
  log("   테이블                       백업   현재(대상)   추가될 행   겹치는 행");
  const hasId = new Map<string, boolean>();
  const missingByTable = new Map<string, number>();
  for (const t of order) {
    const rows = tableRows.get(t);
    if (!rows) continue;
    hasId.set(t, rows.length > 0 && rows[0].id !== undefined);
    let line = `   ${t.padEnd(26)} ${String(rows.length).padStart(6)}`;
    if (hasId.get(t)) {
      const ex = await existingIds(t);
      if (ex) {
        const miss = rows.filter((r) => !ex.has(String(r.id))).length;
        missingByTable.set(t, miss);
        line += `   ${String(ex.size).padStart(10)}   ${String(miss).padStart(9)}   ${String(rows.length - miss).padStart(9)}`;
      }
    } else line += "          (id 없는 테이블 — 건수 비교 불가)";
    log(line);
  }

  let authPlan: Row[] = [];
  const authFile = join(opts.dir, "auth_users.json");
  if (opts.auth) {
    if (!existsSync(authFile)) { log("❌ --auth 를 지정했지만 auth_users.json 이 없습니다."); return 2; }
    authPlan = JSON.parse(readFileSync(authFile, "utf8")) as Row[];
    log(`   로그인 사용자(auth)          ${String(authPlan.length).padStart(6)}   (대상에 없는 사용자만 같은 id 로 생성)`);
  }

  if (!opts.apply) {
    log("\n✅ 비교 완료 — 아무것도 쓰지 않았습니다.");
    log(`   실제로 복원하려면 같은 명령에 다음을 추가하세요:  --apply --confirm-host ${host}`);
    return 0;
  }
  if (opts.confirmHost !== host) {
    log(`\n❌ --confirm-host 가 대상 프로젝트 호스트(${host})와 일치하지 않습니다. 안전을 위해 중단합니다. (입력값: ${opts.confirmHost ?? "없음"})`);
    return 2;
  }

  // ── 4. 실제 복원 ──────────────────────────────────────────────────
  const failures: string[] = [];
  let auditBefore: Set<string> | null = null;
  const restoringAudit = tableRows.has("audit_log");
  if (restoringAudit && !opts.keepAuditArtifacts) auditBefore = (await existingIds("audit_log")) ?? new Set();

  // 4-1. 로그인 사용자 (profiles 등이 참조하므로 먼저)
  if (opts.auth) {
    const have = new Set<string>();
    for (let page = 1; ; page++) {
      const r = await api("GET", `/auth/v1/admin/users?page=${page}&per_page=1000`);
      if (r.status !== 200) { failures.push(`auth: 기존 사용자 조회 실패 HTTP ${r.status}`); break; }
      const list = (JSON.parse(r.text) as { users?: { id: string }[] }).users ?? [];
      list.forEach((u) => have.add(u.id));
      if (list.length < 1000) break;
    }
    let made = 0;
    for (const u of authPlan) {
      if (have.has(String(u.id))) continue;
      const body = { id: u.id, email: u.email, phone: u.phone || undefined, email_confirm: true, user_metadata: u.user_metadata, app_metadata: u.app_metadata };
      const r = await api("POST", "/auth/v1/admin/users", body);
      if (r.status !== 200 && r.status !== 201) { failures.push(`auth ${u.id}: HTTP ${r.status} ${r.text.slice(0, 120)}`); continue; }
      const created = JSON.parse(r.text) as { id?: string };
      if (created.id !== u.id) { failures.push(`auth ${u.id}: 원래 id 로 생성되지 않았습니다 (새 id ${created.id}) — 이 Supabase 버전은 id 지정 생성을 지원하지 않을 수 있습니다`); continue; }
      made++;
    }
    log(`\n로그인 사용자: ${made}명 생성 (이미 있던 ${authPlan.length - made - failures.filter((f) => f.startsWith("auth ")).length}명 제외)`);
  }

  // 4-2. 테이블 데이터
  for (const t of order) {
    const all = tableRows.get(t);
    if (!all) continue;
    const drop = strippedCols.get(t);
    const rows = drop ? all.map((r) => {
      const c: Row = {};
      for (const [k, v] of Object.entries(r)) { if (drop.has(k)) stripped.push({ table: t, id: r.id, column: k, value: v }); else c[k] = v; }
      return c;
    }) : all;
    const useMerge = opts.mode === "overwrite" && hasId.get(t) === true;
    const path = `/rest/v1/${t}` + (useMerge ? "?on_conflict=id" : "");
    const prefer = `resolution=${useMerge ? "merge-duplicates" : "ignore-duplicates"},return=minimal`;
    const size = BATCH[t] ?? DEFAULT_BATCH;
    let ok = 0;
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size);
      const r = await api("POST", path, chunk, { Prefer: prefer });
      if (r.status >= 200 && r.status < 300) { ok += chunk.length; continue; }
      for (const row of chunk) {                           // 배치가 실패하면 한 행씩 나눠 문제 행만 가려냄
        const r1 = await api("POST", path, [row], { Prefer: prefer });
        if (r1.status >= 200 && r1.status < 300) ok++;
        else failures.push(`${t} ${String(row.id ?? "(id 없음)")}: HTTP ${r1.status} ${r1.text.slice(0, 140)}`);
      }
    }
    log(`   ✓ ${t}: ${ok}/${rows.length}건 처리`);
  }

  // 4-3. 복원 때문에 자동으로 생긴 감사 기록 정리 (전체 복원일 때만)
  if (auditBefore) {
    const backupAudit = new Set((tableRows.get("audit_log") ?? []).map((r) => String(r.id)));
    const now = (await existingIds("audit_log")) ?? new Set<string>();
    const artifacts = [...now].filter((id) => !auditBefore!.has(id) && !backupAudit.has(id));
    for (let i = 0; i < artifacts.length; i += 100) {
      const part = artifacts.slice(i, i + 100);
      const r = await api("DELETE", `/rest/v1/audit_log?id=in.(${part.join(",")})`);
      if (r.status < 200 || r.status >= 300) failures.push(`audit_log 자동 기록 정리 실패 HTTP ${r.status}`);
    }
    if (artifacts.length) log(`   ✓ 복원 과정에서 자동 생성된 감사 기록 ${artifacts.length}건 정리`);
  }

  // ── 5. 검증: 백업의 모든 행이 대상에 있는지 다시 확인 ────────────────
  log("\n검증 (백업의 모든 행이 대상에 존재하는지 재확인)");
  for (const t of order) {
    const rows = tableRows.get(t);
    if (!rows || hasId.get(t) !== true) continue;
    const ex = await existingIds(t);
    if (!ex) continue;
    const miss = rows.filter((r) => !ex.has(String(r.id))).length;
    log(`   ${miss === 0 ? "✓" : "✗"} ${t}: 누락 ${miss}건`);
    if (miss > 0) failures.push(`${t}: 복원 후에도 ${miss}건이 대상에 없습니다`);
  }

  if (stripped.length) {
    writeFileSync("restore_unrestored_columns.json", JSON.stringify(stripped));
    log(`\n⚠ 대상에 컬럼이 없어 복원하지 못한 값 ${stripped.length}개를 restore_unrestored_columns.json 에 저장했습니다.`);
  }
  if (failures.length) {
    log(`\n❌ 복원 완료했지만 문제 ${failures.length}건:`);
    failures.slice(0, 30).forEach((f) => log("   - " + f));
    if (failures.length > 30) log(`   … 외 ${failures.length - 30}건`);
    return 1;
  }
  log("\n✅ 복원 완료 — 모든 행이 대상 프로젝트에 존재합니다.");
  return 0;
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2), process.env));
}
