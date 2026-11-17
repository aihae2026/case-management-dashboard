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

function ok(body: unknown, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function extractYoutubeId(url: string): string | null {
  const m =
    url.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
    url.match(/embed\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n/g, " ");
}

import { createClient } from "jsr:@supabase/supabase-js@2";

import { isPrivateHost, resolvesToPrivate } from "./ssrf.ts";

/** 주소 검사에 걸린 요청. 사용자에게 사유를 그대로 보여 준다. */
class UrlBlockedError extends Error {}

/** URL 유효성 + SSRF 사전 차단 */
function validateUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UrlBlockedError("올바른 URL 형식이 아니에요.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new UrlBlockedError("http 또는 https URL만 지원해요.");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new UrlBlockedError("내부 주소로의 요청은 허용되지 않아요.");
  }
  return parsed;
}

/**
 * 리다이렉트를 자동으로 따라가지 않고 직접 따라가며 매 단계의 주소를 다시 검사한다.
 * (처음 주소는 공개 주소여도 내부 주소로 넘겨 주는 우회를 막는다)
 */
const MAX_REDIRECTS = 3;
async function safeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let current = input;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = validateUrl(current);
    if (await resolvesToPrivate(parsed.hostname)) {
      throw new UrlBlockedError("내부 주소로의 요청은 허용되지 않아요.");
    }
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      await res.body?.cancel();
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new UrlBlockedError("리다이렉트가 너무 많아요.");
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

Deno.serve(async (req) => {
  const cors = makeCors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // 실제 JWT 검증 — 로그인한 사용자만 허용
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!, // JWT 검증에는 anon key로 충분
  );
  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    authHeader.replace("Bearer ", ""),
  );
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // 가입 승인 전 계정·기관 미소속 계정은 외부 주소 가져오기를 쓸 수 없다
  if (!(await isApprovedCaller(authHeader, user.id))) {
    return new Response(JSON.stringify({ error: "승인된 기관 멤버만 사용할 수 있습니다." }), {
      status: 403,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string") return ok({ error: "url 필수" }, cors);

    // SSRF 사전 차단
    try {
      validateUrl(url);
    } catch (e) {
      return ok({ error: (e as Error).message }, cors);
    }

    const isYoutube = /youtube\.com|youtu\.be/.test(url);

    // ── YouTube ──────────────────────────────────
    if (isYoutube) {
      const videoId = extractYoutubeId(url);
      let title = "YouTube 영상";
      let author = "";
      let transcriptText = "";

      // 1. oEmbed로 제목·채널 가져오기
      try {
        const oRes = await safeFetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
          { signal: AbortSignal.timeout(8000) },
        );
        if (oRes.ok) {
          const oData = await oRes.json();
          if (oData.title) title = oData.title;
          if (oData.author_name) author = oData.author_name;
        }
      } catch {
        if (videoId) title = `YouTube 영상 (${videoId})`;
      }

      // 2. 영상 페이지에서 자막 트랙 URL 추출 후 스크립트 가져오기
      if (videoId) {
        try {
          const watchRes = await safeFetch(`https://www.youtube.com/watch?v=${videoId}&hl=ko`, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
              "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            signal: AbortSignal.timeout(15000),
          });

          if (watchRes.ok) {
            const html = await watchRes.text();

            // captionTracks 배열에서 baseUrl 추출
            const tracksMatch = html.match(/"captionTracks":(\[.*?\])/);
            if (tracksMatch) {
              let tracks: Array<{ baseUrl: string; languageCode: string }> = [];
              try {
                tracks = JSON.parse(tracksMatch[1]);
              } catch { /* JSON parse 실패 무시 */ }

              // 한국어 우선, 없으면 첫 번째 트랙
              const track =
                tracks.find((t) => t.languageCode === "ko") ||
                tracks.find((t) => t.languageCode === "en") ||
                tracks[0];

              if (track?.baseUrl) {
                const captionUrl = track.baseUrl.replace(/\\u0026/g, "&");
                const captionRes = await safeFetch(captionUrl, { signal: AbortSignal.timeout(10000) });
                if (captionRes.ok) {
                  const xml = await captionRes.text();
                  const texts = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) =>
                    decodeHtmlEntities(m[1]),
                  );
                  transcriptText = texts.join(" ").replace(/\s{2,}/g, " ").trim();
                }
              }
            }
          }
        } catch { /* 자막 추출 실패 — 메타데이터만 저장 */ }
      }

      // 3. 청크 구성
      const header = `[YouTube] ${title}\n채널: ${author || "알 수 없음"}\n주소: ${url}`;
      if (transcriptText) {
        const chunks: Array<{ page: number; text: string }> = [
          { page: 1, text: header },
        ];
        const CHUNK = 2000;
        for (let i = 0; i < transcriptText.length; i += CHUNK) {
          chunks.push({ page: chunks.length + 1, text: transcriptText.slice(i, i + CHUNK) });
        }
        return ok({ title, chunks }, cors);
      } else {
        return ok({
          title,
          chunks: [
            {
              page: 1,
              text:
                header +
                "\n\n(자막 데이터를 가져오지 못했어요. 영상을 직접 시청해주세요.)",
            },
          ],
        }, cors);
      }
    }

    // ── 일반 웹 페이지 ──────────────────────────
    const res = await safeFetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok)
      return ok({
        error: `페이지를 가져오지 못했어요 (HTTP ${res.status}). URL을 확인해주세요.`,
      }, cors);

    const html = await res.text();

    // 제목 추출
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch
      ? decodeHtmlEntities(titleMatch[1])
          .replace(/\s*[-|·]\s*[^<]{0,40}$/, "")
          .trim()
      : new URL(url).hostname;

    // 본문 텍스트 추출
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, " ")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, " ")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, " ")
      .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 16000);

    if (!text) return ok({ error: "페이지에서 텍스트를 추출하지 못했어요." }, cors);

    const chunks: Array<{ page: number; text: string }> = [];
    const CHUNK = 2000;
    for (let i = 0; i < text.length; i += CHUNK) {
      chunks.push({ page: chunks.length + 1, text: text.slice(i, i + CHUNK) });
    }

    return ok({ title, chunks }, cors);
  } catch (err) {
    console.error("[fetch-url]", err);
    if (err instanceof UrlBlockedError) return ok({ error: err.message }, cors);
    return ok({ error: "오류가 발생했어요. 잠시 후 다시 시도해주세요." }, cors);
  }
});
