/**
 * care_plan_action_links 백필 스크립트
 *
 * 사용법: bun scripts/backfill-care-plan-links.ts
 *
 * Phase 4 이중쓰기 이전에 clients.note에 저장된
 * linkedLogIds / linkedProvIds / excludedLogIds / excludedProvIds 를
 * care_plan_action_links 테이블로 일괄 이전한다.
 *
 * - 멱등성 보장: ON CONFLICT DO NOTHING → 여러 번 실행해도 안전
 * - 읽기 전용 검증 (PowerShell): $env:DRY_RUN="true"; bun scripts/backfill-care-plan-links.ts
 * - 필요한 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (PowerShell에서 $env:이름="값" 으로 설정)
 */

import { createClient } from "@supabase/supabase-js";
import { splitNote } from "../src/lib/case-types";

// ── 환경변수 ──────────────────────────────────────────────────────────────
const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
const DRY_RUN = process.env.DRY_RUN === "true";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ 환경변수를 찾을 수 없습니다. 아래 중 하나를 .env.local에서 확인하세요:");
  console.error("   SUPABASE_URL 또는 VITE_SUPABASE_URL");
  console.error("   SUPABASE_SERVICE_ROLE_KEY 또는 SUPABASE_SECRET_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── 타입 ──────────────────────────────────────────────────────────────────
type LinkRow = {
  client_id: string;
  org_id: string;
  plan_year: number;
  action_id: string;
  link_type: "log" | "prov";
  linked_id: string;
  excluded: boolean;
};

// ── 메인 ──────────────────────────────────────────────────────────────────
console.log(`\n🔍 care_plan_action_links 백필 시작 ${DRY_RUN ? "(DRY RUN — DB 변경 없음)" : ""}\n`);

// 1. linkedLogIds/linkedProvIds가 있는 클라이언트만 조회
const { data: clients, error: fetchErr } = await supabase
  .from("clients")
  .select("id, org_id, note")
  .or("note.ilike.%linkedLogIds%,note.ilike.%linkedProvIds%,note.ilike.%excludedLogIds%,note.ilike.%excludedProvIds%");

if (fetchErr) {
  console.error("❌ clients 조회 실패:", fetchErr.message);
  process.exit(1);
}

console.log(`📋 대상 클라이언트: ${clients?.length ?? 0}건\n`);

// 2. 각 클라이언트의 note에서 링크 데이터 추출
const rows: LinkRow[] = [];
let skippedClients = 0;

for (const client of clients ?? []) {
  const { reassessments } = splitNote(client.note);

  for (const r of reassessments) {
    if (!r.carePlan || r.carePlan.rows.length === 0) continue;
    const planYear = Number(r.carePlan.year);
    if (!planYear || isNaN(planYear)) continue;

    for (const row of r.carePlan.rows) {
      for (const action of [...(row.selfPlan ?? []), ...(row.workerPlan ?? [])]) {
        if (!action.id) continue;

        // 수동 연결 (excluded=false)
        for (const logId of action.linkedLogIds ?? []) {
          rows.push({ client_id: client.id, org_id: client.org_id, plan_year: planYear, action_id: action.id, link_type: "log", linked_id: logId, excluded: false });
        }
        for (const provId of action.linkedProvIds ?? []) {
          rows.push({ client_id: client.id, org_id: client.org_id, plan_year: planYear, action_id: action.id, link_type: "prov", linked_id: provId, excluded: false });
        }

        // 수동 제외 (excluded=true)
        for (const logId of action.excludedLogIds ?? []) {
          rows.push({ client_id: client.id, org_id: client.org_id, plan_year: planYear, action_id: action.id, link_type: "log", linked_id: logId, excluded: true });
        }
        for (const provId of action.excludedProvIds ?? []) {
          rows.push({ client_id: client.id, org_id: client.org_id, plan_year: planYear, action_id: action.id, link_type: "prov", linked_id: provId, excluded: true });
        }
      }
    }
  }
}

// 3. 결과 미리보기
const linked  = rows.filter((r) => !r.excluded);
const excluded = rows.filter((r) => r.excluded);

console.log(`📊 추출 결과:`);
console.log(`   linked   (excluded=false): ${linked.length}건`);
console.log(`   excluded (excluded=true) : ${excluded.length}건`);
console.log(`   합계                     : ${rows.length}건\n`);

if (rows.length === 0) {
  console.log("✅ 백필할 데이터 없음. 종료.");
  process.exit(0);
}

if (DRY_RUN) {
  console.log("🟡 DRY RUN 모드 — 실제 삽입 생략. 확인 후 DRY_RUN=false로 실행하세요.");
  process.exit(0);
}

// 4. 배치 upsert (500건 단위)
const BATCH = 500;
let inserted = 0;
let ignored  = 0;

for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const { error } = await supabase
    .from("care_plan_action_links")
    .upsert(batch, {
      onConflict: "client_id,plan_year,action_id,link_type,linked_id",
      ignoreDuplicates: true,
    });

  if (error) {
    console.error(`❌ upsert 실패 (batch ${i}~${i + batch.length}):`, error.message);
    process.exit(1);
  }

  inserted += batch.length;
  console.log(`   ✓ ${inserted}/${rows.length}건 처리`);
}

// 5. 최종 집계
const { count } = await supabase
  .from("care_plan_action_links")
  .select("*", { count: "exact", head: true });

console.log(`\n✅ 백필 완료!`);
console.log(`   삽입 시도: ${rows.length}건 (이미 존재하는 행은 자동 무시)`);
console.log(`   테이블 총 행수: ${count}건\n`);
