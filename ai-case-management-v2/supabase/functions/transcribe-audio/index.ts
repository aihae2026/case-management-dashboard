/**
 * transcribe-audio Edge Function
 * 1. 오디오 파일을 Google Drive "상담녹음" 폴더에 업로드
 * 2. Gemini로 한국어 전사(transcription) 수행
 * 3. { audioUrl, transcript } 반환
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

/** 호출한 사용자가 조회 전용(뷰어)인지 확인한다. 확인 실패 시 false(기존 동작 유지). */
async function isViewerCaller(authHeader: string | null): Promise<boolean> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !anon || !authHeader) return false;
    const c = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data, error } = await c.rpc("is_viewer");
    return !error && data === true;
  } catch {
    return false;
  }
}

/** 호출한 사용자가 기관에 소속되고 가입 승인이 끝났는지 확인한다. 확인 실패 시 false(막음). */
async function isApprovedCaller(authHeader: string | null, userId: string): Promise<boolean> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !anon || !authHeader) return false;
    const c = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: profile, error } = await c
      .from("profiles")
      .select("org_id,status")
      .eq("id", userId)
      .maybeSingle();
    return !error && !!profile?.org_id && profile.status === "approved";
  } catch {
    return false;
  }
}

const ALLOWED_ORIGINS = [
  ...(Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  "http://localhost:8080",
];

function makeCors(req: Request) {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// 대상자가 AI 활용에 동의하지 않았는지(미설정·거부) 확인한다. ai_consent 컬럼이 아직 없으면(마이그레이션 전) 제한하지 않는다.
// deno-lint-ignore no-explicit-any
async function isAiRefused(sb: any, clientId?: string | null): Promise<boolean> {
  if (!clientId) return false;
  const { data, error } = await sb.from("clients").select("ai_consent").eq("id", clientId).maybeSingle();
  if (error) {
    if (error.code === "42703") return false;
    throw new Error("AI 활용 동의 확인 실패: " + error.message);
  }
  const v = data?.ai_consent;
  return v != null && v !== "agree";
}

Deno.serve(async (req) => {
  const cors = makeCors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const DRIVE_URL      = Deno.env.get("DRIVE_UPLOAD_URL");
    const DRIVE_SECRET   = Deno.env.get("DRIVE_SECRET");
    const GEMINI_KEY     = Deno.env.get("GEMINI_API_KEY");
    const GEMINI_MODEL   = Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash";
    const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON  = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SUPABASE_SVC   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!DRIVE_URL || !DRIVE_SECRET) throw new Error("Drive 설정 누락");
    if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY 누락");

    // JWT 인증
    const authHeader = req.headers.get("Authorization");
    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON);
    const { data: { user }, error: authErr } = await authClient.auth.getUser(
      authHeader?.replace("Bearer ", "") ?? ""
    );
    if (authErr || !user) throw new Error("인증 실패");

    // 가입 승인 전 계정·기관 미소속 계정은 녹음 업로드·전사를 쓸 수 없다
    if (!(await isApprovedCaller(authHeader, user.id))) throw new Error("승인된 기관 멤버만 사용할 수 있습니다.");

    const supabase = createClient(SUPABASE_URL, SUPABASE_SVC);

    // 조회 전용(뷰어) 계정은 녹음 업로드·전사를 쓸 수 없다
    if (await isViewerCaller(authHeader)) throw new Error("조회 전용 계정은 녹음 업로드와 전사를 사용할 수 없어요.");

    // 요청 파싱: name, mimeType, data(base64), clientId
    const { name, mimeType, data, clientId } = await req.json();
    if (!name || !mimeType || !data) throw new Error("파일 정보 누락");

    // 파일 크기 제한: 20MB
    const MAX_BYTES = 20 * 1024 * 1024;
    const estimatedBytes = Math.floor((data as string).length * 0.75);
    if (estimatedBytes > MAX_BYTES) {
      throw new Error(
        `파일 크기가 20MB를 초과합니다 (${(estimatedBytes / 1024 / 1024).toFixed(1)}MB). ` +
        "녹음 시간을 줄여주세요."
      );
    }

    // Gemini inline_data에는 codecs 파라미터 없는 base MIME type만 허용
    // "audio/webm;codecs=opus" → "audio/webm"
    const geminiMime = mimeType.split(";")[0].trim();

    // 1 & 2: Drive 업로드 + Gemini 전사 병렬 처리 (순차 시 타임아웃 위험)
    const transcribePrompt =
      "당신은 한국어 음성 전사 전문가입니다. " +
      "아래 음성 파일은 사회복지관 사례관리 담당자와 어르신 간의 상담 녹음입니다.\n" +
      "음성 내용을 최대한 정확하게 한국어 텍스트로 전사해 주세요.\n\n" +
      "규칙:\n" +
      "1. 들린 내용을 그대로 전사하세요. 요약하거나 수정하지 마세요.\n" +
      "2. 말이 불분명한 경우 [불명확]으로 표시하세요.\n" +
      "3. 담당자와 어르신의 발화가 구분되면 '담당자:' / '어르신:' 으로 구분해 주세요.\n" +
      "4. 전사된 텍스트만 출력하고 설명이나 머리말을 붙이지 마세요.";

    // AI 활용을 거부한 대상자는 Gemini로 보내지 않고 녹음 파일만 저장한다
    const aiRefused = await isAiRefused(supabase, clientId);

    // Drive 업로드와 Gemini 전사를 병렬 실행
    // Drive 실패해도 전사 결과는 반드시 살림 (Promise.allSettled 사용)
    const [driveResult, geminiResult] = await Promise.allSettled([
      // Drive 업로드
      fetch(DRIVE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: DRIVE_SECRET,
          name,
          mimeType,
          data,
          folderName: "상담녹음",
        }),
      }).then((r) => r.json()),

      // Gemini 전사 (geminiMime: codecs 제거)
      aiRefused ? Promise.resolve(null) : fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: "POST",
          // API 키는 주소가 아니라 헤더로 보낸다(오류 메시지에 키가 섞여 나가지 않게)
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [
                { text: transcribePrompt },
                { inline_data: { mime_type: geminiMime, data } },
              ],
            }],
            generationConfig: { temperature: 0.1 },
          }),
        }
      ).then((r) => r.json()),
    ]);

    // Gemini 전사 결과 추출 (실패해도 빈 문자열로 graceful 처리)
    const geminiData = geminiResult.status === "fulfilled" ? geminiResult.value : null;
    const transcript: string =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";

    // Drive 결과 추출 (실패해도 전사 결과는 반환)
    const driveData = driveResult.status === "fulfilled" ? driveResult.value : null;
    const audioUrl: string | null = driveData?.url ?? null;
    const driveError: string | null =
      driveResult.status === "rejected"
        ? String(driveResult.reason)
        : (driveData?.error ? "Drive 업로드 실패: " + driveData.error : null);

    // DB files 테이블에 메타데이터 저장 (Drive 성공한 경우에만, best-effort)
    if (audioUrl) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("org_id, name")
        .eq("id", user.id)
        .single();
      if (profile?.org_id) {
        await supabase.from("files").insert({
          org_id: profile.org_id,
          client_id: clientId ?? null,
          name: driveData.name,
          drive_file_id: driveData.id,
          drive_url: audioUrl,
          mime_type: mimeType,
          size_bytes: driveData.size,
          uploaded_by: profile.name,
        });
      }
    }

    return new Response(
      // model: 전사에 실제로 쓴 모델(AI를 거부해 전사하지 않았으면 null). 화면의 AI 모델 표시에 쓴다.
      JSON.stringify({ audioUrl, transcript, driveError, aiBlocked: aiRefused, model: aiRefused ? null : GEMINI_MODEL }),
      { headers: { ...cors, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[transcribe-audio]", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
