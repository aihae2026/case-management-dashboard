// 제미나이(Gemini) 호출 프록시 Edge Function.
// 키는 Supabase Edge 시크릿 GEMINI_API_KEY 로 보관한다(러버블 게이트웨이/크레딧 불필요).
// - body { ping: true } → { enabled, model } 상태 반환
// - body { system, user, json } → { text, model } 완성 결과 반환
// verify_jwt(기본 true)로 로그인 사용자만 호출 가능하고, 가입 승인된 기관 멤버만 AI 호출이 허용된다(ping 제외).
//
// 사용량(429/quota) 대응 3종:
//  1) 모델 폴백 — 무료 quota는 모델별로 따로이므로, 429면 다음 모델로 자동 전환한다.
//  2) 429 재시도 — Google이 준 retryDelay(없으면 4초)만큼 짧게 1회 대기 후 재시도.
//     단 웹 요청 타임아웃 방지를 위해 대기 상한(GEMINI_MAX_RETRY_WAIT_MS, 기본 8초)을 둔다.
//  3) 비-429(인증 등) 오류는 재시도 무의미 → 즉시 반환.
//
// 작업별 모델(정확도가 중요한 작업만 다른 모델을 쓴다):
//  - body { task: "resource" } → 자원 배분 도우미는 시크릿 GEMINI_MODEL_RESOURCE(기본 gemini-4-argon)로 먼저 호출한다.
//    "off" 로 두면 사용하지 않는다(= 기본 모델). 이 모델이 오류·접근 불가·시간 초과면 자동으로 기본 모델(+폴백)로 돌아간다.
//  - 결과의 model 에는 실제로 답한 모델 이름이 들어가고, ping 에 task 를 같이 보내면 그 작업에 설정된 모델을 알려 준다.

import { createClient } from "jsr:@supabase/supabase-js@2";

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
async function isApprovedCaller(authHeader: string | null): Promise<boolean> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !anon || !authHeader) return false;
    const c = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await c.auth.getUser(authHeader.replace("Bearer ", ""));
    if (userErr || !userData?.user) return false;
    const { data: profile, error } = await c
      .from("profiles")
      .select("org_id,status")
      .eq("id", userData.user.id)
      .maybeSingle();
    return !error && !!profile?.org_id && profile.status === "approved";
  } catch {
    return false;
  }
}

function json(body: unknown, cors: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 429 본문에서 Google이 제시한 retryDelay(초)를 뽑는다. (예: "retryDelay":"32s") */
function parseRetrySec(detail: string): number | null {
  const m = detail.match(/"?retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/i);
  return m ? Number(m[1]) : null;
}

type CallResult = { ok: boolean; status: number; text?: string; detail?: string };

// 작업별 모델: 작업 이름 → [시크릿 이름, 기본값]. 목록에 있는 작업만 허용한다(임의 모델 이름은 받지 않는다).
const TASK_MODELS: Record<string, { env: string; fallback: string }> = {
  resource: { env: "GEMINI_MODEL_RESOURCE", fallback: "gemini-4-argon" },
};

/** 작업에 지정된 모델. 지정이 없거나 "off" 면 null(기본 모델 사용). */
function taskModel(task: unknown): string | null {
  if (typeof task !== "string" || !Object.hasOwn(TASK_MODELS, task)) return null;
  const t = TASK_MODELS[task];
  const v = (Deno.env.get(t.env) ?? t.fallback).trim();
  return !v || v.toLowerCase() === "off" ? null : v;
}

/** 단일 모델로 1회 호출. */
async function callGemini(
  key: string,
  model: string,
  body: { system?: string; user?: string; json?: boolean; temperature?: number },
  timeoutMs?: number,
): Promise<CallResult> {
  // API 키는 주소(?key=)가 아니라 헤더로 보낸다. 주소에 키가 있으면 네트워크 오류 메시지에 키가 섞여 화면으로 나갈 수 있다.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      body: JSON.stringify({
      ...(body.system ? { systemInstruction: { parts: [{ text: body.system }] } } : {}),
      contents: [{ role: "user", parts: [{ text: body.user }] }],
      generationConfig: {
        temperature: body.temperature ?? 0.4,
        ...(body.json ? { responseMimeType: "application/json" } : {}),
      },
    }),
    });
  } catch (e) {
    // 시간 초과·네트워크 오류는 다음 모델로 넘어갈 수 있게 504 로 돌려준다
    // 오류 메시지에 요청 주소·키가 들어 있을 수 있어 주소와 key= 값을 지우고 돌려준다
    const safe = `${(e as Error).message}`.replace(/https?:\/\/\S+/g, "<url>").replace(/key=[^&\s)"']+/g, "key=***");
    return { ok: false, status: 504, detail: `요청 실패(${(e as Error).name}): ${safe}`.slice(0, 300) };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    return { ok: false, status: res.status, detail };
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  };
  const finishReason = data.candidates?.[0]?.finishReason;
  const text =
    (data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "").trim();
  if (finishReason === "MAX_TOKENS") {
    console.warn("[gemini] 응답이 토큰 한도로 잘렸습니다. 텍스트 길이:", text.length);
  }
  return { ok: true, status: 200, text };
}

Deno.serve(async (req) => {
  const cors = makeCors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const key = Deno.env.get("GEMINI_API_KEY");
  // 모델·설정은 매 호출마다 읽어 시크릿 변경이 즉시 반영되게 한다.
  const primaryModel = Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash";
  const fallbacks = (Deno.env.get("GEMINI_FALLBACK_MODELS") || "gemini-3.6-flash")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // 지정 모델 우선, 그다음 폴백들. 각 모델은 별도 무료 quota를 쓴다.
  // 작업별 모델(task)이 있으면 그 모델을 맨 앞에 두고, 실패하면 기본 모델·폴백으로 이어진다.
  let body: {
    task?: string;
    ping?: boolean;
    system?: string;
    user?: string;
    json?: boolean;
    temperature?: number;
  } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const override = taskModel(body.task);
  const models = [...new Set([...(override ? [override] : []), primaryModel, ...fallbacks])];
  const MAX_WAIT_MS = Number(Deno.env.get("GEMINI_MAX_RETRY_WAIT_MS") || 8000);
  // 작업별 모델이 응답이 없을 때 오래 기다리지 않고 기본 모델로 넘어가기 위한 제한(웹 요청 제한 안에서 폴백할 시간을 남긴다)
  const OVERRIDE_TIMEOUT_MS = Number(Deno.env.get("GEMINI_OVERRIDE_TIMEOUT_MS") || 60000);

  // 상태 확인용 핑: task 를 함께 보내면 그 작업에 설정된 모델을 알려 준다
  if (body.ping) return json({ enabled: !!key, model: override ?? primaryModel }, cors);

  // 가입 승인 전 계정·기관 미소속 계정은 기관의 AI 키를 쓸 수 없다
  if (!(await isApprovedCaller(req.headers.get("Authorization")))) {
    return json({ error: "승인된 기관 멤버만 사용할 수 있습니다." }, cors);
  }

  // 조회 전용(뷰어) 계정은 AI 기능을 쓸 수 없다 (분석 결과 저장·외부 전송이 일어나므로)
  if (await isViewerCaller(req.headers.get("Authorization"))) {
    return json({ error: "조회 전용 계정은 AI 기능을 사용할 수 없어요." }, cors);
  }

  // 논리적 오류도 200으로 돌려보내 호출측(supabase-js invoke)이 본문을 쉽게 읽게 한다.
  if (!key) return json({ error: "GEMINI_API_KEY missing" }, cors);
  if (!body.user) return json({ error: "user prompt required" }, cors);

  let lastErr = "";
  for (const model of models) {
    // 작업별 모델(기본 모델과 다른 경우)은 실패해도 기본 모델로 이어 가야 한다
    const isOverride = !!override && model === override && override !== primaryModel;
    // 모델당: 최초 1회 + (429면) 짧은 대기 후 1회 재시도
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await callGemini(key, model, body, isOverride ? OVERRIDE_TIMEOUT_MS : undefined);
      if (r.ok) return json({ text: r.text, model }, cors); // 성공한 모델명도 함께 반환
      lastErr = `Gemini ${r.status}: ${r.detail ?? ""}`;
      if (isOverride) console.warn(`[gemini] 작업별 모델(${model}) 실패 → 기본 모델로 전환:`, r.status, (r.detail ?? "").slice(0, 120));

      if (r.status === 429) {
        // Google 제안 대기(없으면 4초). 상한 이하일 때만 같은 모델 재시도, 아니면 다음 모델로.
        const waitMs = (parseRetrySec(r.detail ?? "") ?? 4) * 1000;
        if (attempt === 0 && waitMs > 0 && waitMs <= MAX_WAIT_MS) {
          await sleep(waitMs);
          continue;
        }
        break; // 다음 모델 시도
      }
      // 인증/권한 오류는 어떤 모델로도 동일 → 즉시 반환. 단 작업별 모델은 그 모델만 접근이 막혔을 수 있어 기본 모델로 계속한다.
      if ((r.status === 401 || r.status === 403) && !isOverride) return json({ error: lastErr }, cors);
      // 그 외(400/404 모델 미지원, 5xx 등)는 다음 모델로 폴백
      break;
    }
  }
  return json({ error: lastErr || "Gemini 호출 실패" }, cors);
});
