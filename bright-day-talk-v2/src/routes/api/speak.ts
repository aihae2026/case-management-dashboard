import { createFileRoute } from "@tanstack/react-router";
import { GEMINI_TTS_MODEL } from "@/lib/ai-gateway.server";
import { VOICE_OPTIONS } from "@/lib/profile";

// Text-to-speech via Gemini TTS API.
type SpeakBody = { text?: unknown; voiceName?: unknown; sessionId?: unknown };

// raw PCM(L16, 24 kHz mono 16-bit)을 WAV 컨테이너로 감싼다.
// Gemini TTS가 반환하는 PCM은 브라우저가 직접 재생 불가 → WAV 헤더 필요.
function wrapInWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);         // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

// 소프트 리미터: SOFT_KNEE 이하는 그대로, 넘는 부분은 tanh 곡선으로 ±1 안쪽에 부드럽게 수렴시킨다.
const SOFT_KNEE = 0.6;
function softLimit(x: number): number {
  const a = Math.abs(x);
  if (a <= SOFT_KNEE) return x;
  const y = SOFT_KNEE + (1 - SOFT_KNEE) * Math.tanh((a - SOFT_KNEE) / (1 - SOFT_KNEE));
  return x < 0 ? -y : y;
}

export const Route = createFileRoute("/api/speak")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env.GEMINI_API_KEY;
        if (!key) {
          return Response.json({ ok: false, error: "ai_not_configured" }, { status: 500 });
        }

        const { text, voiceName, sessionId } = (await request.json().catch(() => ({}))) as SpeakBody;

        // ── S-1/S-2: sessionId 인증 ──────────────────────────────────────
        if (typeof sessionId !== "string" || !sessionId.trim()) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: senior } = await supabaseAdmin
            .from("seniors")
            .select("session_id")
            .eq("session_id", sessionId.trim())
            .maybeSingle();
          if (!senior) {
            // DB에 없는 sessionId — fail-open (어르신 TTS 중단 방지; rate limit이 보호)
            console.warn("[speak] sessionId not in seniors, allowing:", sessionId.trim().slice(0, 8));
          }
        } catch (authErr) {
          // DB 오류 시 fail-open (서비스 중단 방지)
          console.error("[speak] auth check failed, allowing:", authErr);
        }

        // 승인 확인: 해제·삭제·미승인 기기는 서버에서 차단 (DB 장애 시에는 통과)
        const { isSessionApproved } = await import("@/lib/session-guard.server");
        if ((await isSessionApproved(sessionId.trim())) === false) {
          return Response.json({ ok: false, error: "not_approved" }, { status: 403 });
        }

        // ── S-3: Rate Limiting (Upstash — env 없으면 skip) ──────────────
        // Vercel KV 연동 시 KV_REST_API_URL/TOKEN, 직접 설정 시 UPSTASH_REDIS_REST_URL/TOKEN
        const redisUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
        const redisToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
        if (redisUrl && redisToken) {
          try {
            const { Redis } = await import("@upstash/redis");
            const { Ratelimit } = await import("@upstash/ratelimit");
            const ratelimit = new Ratelimit({
              redis: new Redis({ url: redisUrl, token: redisToken }),
              limiter: Ratelimit.fixedWindow(20, "60s"), // 분당 20회 (어르신 여유롭게)
              prefix: "bdt:speak",
            });
            const { success } = await ratelimit.limit(sessionId.trim());
            if (!success) {
              return Response.json({ ok: false, error: "too_many_requests" }, { status: 429 });
            }
          } catch (rlErr) {
            console.error("[speak] rate limit check failed, allowing:", rlErr);
          }
        }

        if (typeof text !== "string" || !text.trim()) {
          return Response.json({ ok: false, error: "text_required" }, { status: 400 });
        }

        const input = text.trim().slice(0, 1200);
        // 허용 목소리 목록 — profile.ts VOICE_OPTIONS 단일 소스에서 파생
        const ALLOWED_VOICES = VOICE_OPTIONS.map((v) => v.name as string);
        const voice = typeof voiceName === "string" && ALLOWED_VOICES.includes(voiceName)
          ? voiceName
          : "Puck";

        const ttsController = new AbortController();
        const ttsTimer = setTimeout(() => ttsController.abort(), 15000);
        let resp: Response;
        try {
          resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`,
            {
              method: "POST",
              // 키를 주소(?key=)에 넣으면 오류 로그에 주소와 함께 남을 수 있어 헤더로 보낸다
              headers: { "Content-Type": "application/json", "x-goog-api-key": key },
              body: JSON.stringify({
                contents: [{ parts: [{ text: input }] }],
                generationConfig: {
                  responseModalities: ["AUDIO"],
                  speechConfig: {
                    voiceConfig: {
                      prebuiltVoiceConfig: {
                        voiceName: voice,
                      },
                    },
                  },
                },
              }),
              signal: ttsController.signal,
            },
          );
        } catch (fetchErr) {
          clearTimeout(ttsTimer);
          const isTimeout = fetchErr instanceof Error && fetchErr.name === "AbortError";
          console.error(`[speak] Gemini TTS fetch 실패:`, isTimeout ? "timeout (15s)" : fetchErr);
          return Response.json({ ok: false, error: "tts_failed" }, { status: 503 });
        }
        clearTimeout(ttsTimer);

        if (!resp.ok) {
          const detail = await resp.text().catch(() => "");
          console.error(`[speak] Gemini TTS failed ${resp.status}: ${detail}`);
          return Response.json({ ok: false, error: "tts_failed" }, { status: resp.status });
        }

        const json = (await resp.json()) as {
          candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
        };

        const audioData = json.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        const mimeType = json.candidates?.[0]?.content?.parts?.[0]?.inlineData?.mimeType ?? "";

        if (!audioData) {
          console.error("[speak] Gemini TTS: no audio data in response", JSON.stringify(json).slice(0, 300));
          return Response.json({ ok: false, error: "tts_failed" }, { status: 500 });
        }

        console.log("[speak] mimeType:", mimeType, "dataLen:", audioData.length);

        let audioBuffer: Buffer = Buffer.from(audioData, "base64");

        // Gemini TTS는 raw PCM(L16, 24kHz)을 반환 → WAV 헤더 필요
        // audio/wav가 이미 반환된 경우 재래핑 방지
        const isPcm = mimeType.toLowerCase().includes("pcm") || mimeType.toLowerCase().includes("l16");
        if (isPcm || !mimeType) {
          // RMS 정규화 — peak이 아닌 체감 음량(loudness)을 YouTube 수준으로 맞춤
          const sampleCount = Math.floor(audioBuffer.length / 2);
          let sumSq = 0;
          for (let i = 0; i < audioBuffer.length - 1; i += 2) {
            const s = audioBuffer.readInt16LE(i) / 32768;
            sumSq += s * s;
          }
          const rms = Math.sqrt(sumSq / sampleCount);
          const TARGET_RMS = 0.25; // -12 dBFS, 스트리밍 음악 수준
          if (rms > 0.001 && rms < TARGET_RMS) {
            const gain = Math.min(TARGET_RMS / rms, 20); // 최대 20배
            // 크게 키운 뒤 한계를 넘는 소리가 뚝 잘리면(하드 클리핑) 찢어지는 소리가 나므로,
            // 일정 크기를 넘는 부분은 부드럽게 눌러서 같은 음량에서 왜곡을 줄인다.
            for (let i = 0; i < audioBuffer.length - 1; i += 2) {
              const x = (audioBuffer.readInt16LE(i) / 32768) * gain;
              audioBuffer.writeInt16LE(Math.round(softLimit(x) * 32767), i);
            }
            console.log(`[speak] RMS normalized: rms=${rms.toFixed(4)} → gain=${gain.toFixed(2)}x`);
          }

          // 일부 Windows 드라이버가 24kHz 미지원 → 48kHz로 업샘플링
          const upsampled = Buffer.alloc(audioBuffer.length * 2);
          for (let i = 0; i < audioBuffer.length; i += 2) {
            upsampled[i * 2]     = audioBuffer[i];
            upsampled[i * 2 + 1] = audioBuffer[i + 1];
            upsampled[i * 2 + 2] = audioBuffer[i];
            upsampled[i * 2 + 3] = audioBuffer[i + 1];
          }
          audioBuffer = wrapInWav(upsampled, 48000, 1, 16);
        }

        return new Response(audioBuffer as unknown as BodyInit, {
          headers: {
            "Content-Type": "audio/wav",
            "Cache-Control": "no-store",
            "X-TTS-MimeType": mimeType || "empty",
            "X-TTS-DataLen": String(audioData.length),
          },
        });
      },
    },
  },
});
