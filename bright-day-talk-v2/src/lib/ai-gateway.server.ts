import { createGoogleGenerativeAI } from "@ai-sdk/google";

// Direct Gemini API provider. Set GEMINI_API_KEY in .env.local.
export function createGeminiProvider() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  return createGoogleGenerativeAI({ apiKey });
}

export const GEMINI_CHAT_MODEL = "gemini-3.8-flash";
export const GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
