// 복순이 DB 자동 백업 → Google Drive
// 백업 대상: seniors, chat_messages
// 인증: Supabase Cron(서비스 롤 자동) 또는 x-backup-secret 헤더(수동 테스트)
// 주기: 매주 금요일 19:00 KST (Supabase Cron 설정)
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function toBase64(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Supabase는 한 번에 최대 1,000행만 돌려주므로 id 순서로 페이지를 넘기며 전부 읽는다.
// deno-lint-ignore no-explicit-any
async function fetchAll(supabase: any, table: string): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`조회 실패: ${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

async function uploadToDrive(
  driveUrl: string,
  driveSecret: string,
  name: string,
  json: string,
  folderName: string,
): Promise<{ id: string; url: string }> {
  const res = await fetch(driveUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({
      secret: driveSecret,
      name,
      mimeType: "application/json",
      data: toBase64(json),
      folderName,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error("Drive 업로드 실패: " + data.error);
  return { id: data.id, url: data.url };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const DRIVE_URL    = Deno.env.get("DRIVE_UPLOAD_URL");
    const DRIVE_SECRET = Deno.env.get("DRIVE_SECRET");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    // 파일이 저장될 Drive 폴더명 — Apps Script 루트 폴더 안의 하위 폴더
    // 기본값: "구글 드라이브 업로드_복순이" (이미 Drive에 존재하는 복순이 전용 폴더)
    const FOLDER_NAME  = Deno.env.get("BOKDORI_DRIVE_FOLDER") ?? "구글 드라이브 업로드_복순이";

    if (!DRIVE_URL || !DRIVE_SECRET) {
      throw new Error("DRIVE_UPLOAD_URL 또는 DRIVE_SECRET 미설정 — Supabase Edge Function Secrets 확인");
    }

    // 인증: Supabase Cron(서비스 롤) 또는 수동 테스트(x-backup-secret)
    const authHeader  = req.headers.get("Authorization") ?? "";
    const testSecret  = req.headers.get("x-backup-secret") ?? "";
    const isServiceRole = SUPABASE_KEY && authHeader === `Bearer ${SUPABASE_KEY}`;
    const isManualTest  = testSecret.length > 0 && testSecret === (Deno.env.get("BACKUP_SECRET") ?? "");
    if (!isServiceRole && !isManualTest) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL!, SUPABASE_KEY!);
    const today    = new Date().toISOString().slice(0, 10);
    const backedUpAt = new Date().toISOString();

    // ── 테이블 병렬 조회 (1,000행 제한을 넘도록 페이지 단위로 끝까지 읽음) ──
    const [seniorsRows, messagesRows] = await Promise.all([
      fetchAll(supabase, "seniors"),
      fetchAll(supabase, "chat_messages"),
    ]);

    const snapshot = {
      backed_up_at: backedUpAt,
      project: "<프로젝트 ID>",
      counts: {
        seniors:       seniorsRows.length,
        chat_messages: messagesRows.length,
      },
      seniors:       seniorsRows,
      chat_messages: messagesRows,
    };

    const json   = JSON.stringify(snapshot, null, 2);
    const sizeMB = (new TextEncoder().encode(json).length / 1024 / 1024).toFixed(2);

    const driveResult = await uploadToDrive(
      DRIVE_URL,
      DRIVE_SECRET,
      `bokdori_backup_${today}.json`,
      json,
      FOLDER_NAME,
    );

    return new Response(
      JSON.stringify({
        ok:       true,
        date:     today,
        sizeMB,
        counts:   snapshot.counts,
        folder:   FOLDER_NAME,
        driveId:  driveResult.id,
        driveUrl: driveResult.url,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
