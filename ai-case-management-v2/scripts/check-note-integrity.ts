/**
 * clients.note 무결성 점검 스크립트 (읽기 전용 — DB를 절대 수정하지 않음)
 *
 * 사용법 (PowerShell):
 *   $env:SUPABASE_URL="https://xxxx.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY="(service_role 키)"
 *   bun scripts/check-note-integrity.ts
 *
 * 점검 내용
 *  - note 안의 구조화 JSON(재사정·계획서·가족관계 등)이 파싱되는지
 *  - 파싱은 되지만 앱이 읽다가 문제를 일으킬 모양인지 (배열이어야 할 곳이 배열이 아님 등)
 *  - 구분자(␞재사정␞)가 사라지고 JSON 조각만 비고에 남은 것으로 의심되는지
 *
 * 개인정보 보호: 출력에는 건수와 대상자 ID, 문제 종류만 나옵니다. note 내용·이름은 출력하지 않습니다.
 */

import { createClient } from "@supabase/supabase-js";
import { splitNote } from "../src/lib/case-types";

// case-types.ts의 REASSESS_SEP와 반드시 같아야 함 (현재 export되지 않아 복사)
const SEP = "\n␞재사정␞\n";

export type Verdict =
  | { kind: "empty" }
  | { kind: "plain" }
  | { kind: "ok" }
  | { kind: "parse_fail" }
  | { kind: "shape_issue"; reasons: string[] }
  | { kind: "sep_missing_suspect" }
  | { kind: "app_crash" };

const isArr = Array.isArray;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !isArr(v);

/** 파싱된 JSON이 앱 코드가 기대하는 모양인지 검사 */
function shapeIssues(parsed: unknown): string[] {
  const issues: string[] = [];
  let reassessments: unknown[] = [];

  if (isArr(parsed)) {
    reassessments = parsed; // 구버전: 재사정 배열
  } else if (isObj(parsed)) {
    if (!parsed.r && !parsed.ga) {
      reassessments = [parsed]; // 구버전: 단일 재사정 객체 (splitNote가 허용)
    } else {
      if (parsed.r !== undefined && parsed.r !== null && !isArr(parsed.r)) issues.push("r(재사정)이 배열이 아님");
      else reassessments = (parsed.r as unknown[]) ?? [];
      if (parsed.sd !== undefined && parsed.sd !== null && !isArr(parsed.sd)) issues.push("sd(밑반찬)가 배열이 아님");
      if (parsed.fm !== undefined && parsed.fm !== null && !isArr(parsed.fm)) issues.push("fm(가족관계)이 배열이 아님");
      if (parsed.cr !== undefined && parsed.cr !== null && typeof parsed.cr !== "string") issues.push("cr(종결사유)가 문자열이 아님");
    }
  } else if (parsed !== null) {
    issues.push("JSON 최상위가 객체/배열이 아님");
  }

  reassessments.forEach((r, i) => {
    if (!isObj(r)) {
      issues.push(`재사정[${i}]이 객체가 아님`);
      return;
    }
    const cp = r.carePlan;
    if (cp === undefined || cp === null) return;
    if (!isObj(cp) || !isArr(cp.rows)) {
      issues.push(`재사정[${i}].carePlan.rows가 배열이 아님`);
      return;
    }
    (cp.rows as unknown[]).forEach((row, j) => {
      if (!isObj(row)) {
        issues.push(`재사정[${i}] 계획 행[${j}]이 객체가 아님`);
        return;
      }
      // 앱 여러 곳이 [...row.selfPlan, ...row.workerPlan] 를 그대로 펼치므로 둘 다 배열이어야 함
      if (!isArr(row.selfPlan)) issues.push(`재사정[${i}] 계획 행[${j}].selfPlan이 배열이 아님`);
      if (!isArr(row.workerPlan)) issues.push(`재사정[${i}] 계획 행[${j}].workerPlan이 배열이 아님`);
    });
  });

  // 같은 종류의 문제는 한 번만 보이게 정리
  return [...new Set(issues.map((s) => s.replace(/\[\d+\]/g, "[n]")))];
}

/** note 문자열 하나를 검사. 순수 함수(DB 접근 없음). */
export function analyzeNote(note: string | null | undefined): Verdict {
  const s = note ?? "";
  if (s.trim() === "") return { kind: "empty" };

  const i = s.indexOf(SEP);
  if (i < 0) {
    // 구분자가 없는데 JSON 조각이 비고에 남아 있으면 구분자가 지워진 것으로 의심
    if (/"reassessedAt"|"carePlan"|\{"r":\[|"selfPlan"/.test(s)) return { kind: "sep_missing_suspect" };
    return { kind: "plain" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(i + SEP.length));
  } catch {
    return { kind: "parse_fail" };
  }

  const reasons = shapeIssues(parsed);
  if (reasons.length > 0) return { kind: "shape_issue", reasons };

  // 실제 앱 함수로도 한 번 돌려 봄 (splitNote는 실패 시 note 일부를 console.error로 찍으므로 출력을 막는다)
  const orig = console.error;
  console.error = () => {};
  try {
    const r = splitNote(s);
    if (!isArr(r.reassessments) || !isArr(r.sideDishAssessments) || !isArr(r.mealOpinion) || !isArr(r.familyMembers)) {
      return { kind: "app_crash" };
    }
  } catch {
    return { kind: "app_crash" };
  } finally {
    console.error = orig;
  }
  return { kind: "ok" };
}

// ── 실행부 ───────────────────────────────────────────────────────────────
async function main() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    console.error("❌ 환경변수가 없습니다: SUPABASE_URL(또는 VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY(또는 SUPABASE_SECRET_KEY)");
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  console.log("\n🔍 clients.note 무결성 점검 (읽기 전용 — 아무것도 수정하지 않습니다)\n");

  // Supabase 기본 1000행 제한을 피하기 위해 페이지 단위로 읽음
  const PAGE = 500;
  const rows: { id: string; org_id: string; note: string | null }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("clients")
      .select("id, org_id, note")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("❌ clients 조회 실패:", error.message);
      process.exit(1);
    }
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }

  const tally: Record<string, string[]> = {
    empty: [], plain: [], ok: [], parse_fail: [], shape_issue: [], sep_missing_suspect: [], app_crash: [],
  };
  const reasonsById = new Map<string, string[]>();
  let multiSep = 0;

  for (const r of rows) {
    const v = analyzeNote(r.note);
    tally[v.kind].push(r.id);
    if (v.kind === "shape_issue") reasonsById.set(r.id, v.reasons);
    if (((r.note ?? "").split(SEP).length - 1) > 1) multiSep++;
  }

  const bad = ["parse_fail", "shape_issue", "sep_missing_suspect", "app_crash"] as const;
  const badCount = bad.reduce((n, k) => n + tally[k].length, 0);

  console.log(`전체 대상자: ${rows.length}명`);
  console.log(`  note 없음            : ${tally.empty.length}`);
  console.log(`  일반 텍스트(비고만)   : ${tally.plain.length}`);
  console.log(`  구조화 데이터 정상    : ${tally.ok.length}`);
  console.log(`  ⚠ 문제 의심          : ${badCount}\n`);

  const label: Record<(typeof bad)[number], string> = {
    parse_fail: "JSON 파싱 실패 (저장 시 계획서·재사정 등이 빈 값으로 덮어써질 위험)",
    shape_issue: "JSON은 읽히지만 모양이 앱 기대와 다름 (화면 오류 가능)",
    sep_missing_suspect: "구분자가 사라지고 JSON 조각이 비고에 남은 것으로 의심",
    app_crash: "앱 함수(splitNote)로 읽다가 오류",
  };
  for (const k of bad) {
    if (tally[k].length === 0) continue;
    console.log(`❌ ${label[k]} — ${tally[k].length}건`);
    for (const id of tally[k]) {
      const why = reasonsById.get(id);
      console.log(`   - ${id}${why ? "  [" + why.join("; ") + "]" : ""}`);
    }
    console.log("");
  }
  if (multiSep > 0) {
    console.log(`ℹ 구분자가 2번 이상 들어 있는 note: ${multiSep}건 (비고에 구분자가 섞였을 가능성)\n`);
  }

  if (badCount === 0) {
    console.log("✅ 문제 의심 건 없음. 모든 note가 정상적으로 읽힙니다.\n");
  } else {
    console.log("👉 위 대상자 ID로 audit_log(변경 이력)를 확인하면 원인과 복구 가능 여부를 볼 수 있습니다.\n");
  }
}

if (import.meta.main) {
  await main();
}
