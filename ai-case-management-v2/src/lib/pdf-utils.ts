/**
 * pdf-utils.ts — SideDishTab / SideDishAddDialog 공통 PDF 유틸리티
 */
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";


// ── PDF 텍스트 추출 ───────────────────────────────────────────────────
export async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(
      content.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return parts.filter(Boolean).join("\n");
}

// ── AI 오류 메시지 ────────────────────────────────────────────────────
export function aiErrorMsg(msg: string): string {
  if (/GEMINI_API_KEY missing/.test(msg)) return "제미나이 키가 필요합니다.";
  if (/\b429\b|quota|rate.?limit|exceeded/i.test(msg))
    return "제미나이 무료 사용량을 초과했어요. 잠시 뒤 다시 시도해 주세요.";
  return "AI 분석 실패: " + msg;
}

// ── Google Drive 업로드 (drive-proxy Edge Function 경유) ─────────────
import type { SupabaseClient } from "@supabase/supabase-js";

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  const parts: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

export async function uploadFileToDrive(
  supabase: SupabaseClient,
  file: File,
  folderName: string,
): Promise<{ id: string; url: string }> {
  const base64 = await fileToBase64(file);
  const { data, error } = await supabase.functions.invoke("drive-proxy", {
    body: { name: file.name, mimeType: file.type || "application/pdf", data: base64, folderName },
  });
  if (error) throw new Error(error.message);
  const result = data as { id?: string; url?: string; error?: string };
  if (result.error) throw new Error(result.error);
  return { id: result.id!, url: result.url! };
}
