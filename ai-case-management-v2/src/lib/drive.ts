/**
 * Google Drive 릴레이 (drive-proxy Edge Function 경유) 공통 유틸
 * ─────────────────────────────────────────────────────────────────
 * DRIVE_SECRET은 서버(supabase/functions/drive-proxy)에만 존재.
 * 클라이언트는 인증된 Supabase 세션으로 drive-proxy를 호출하고,
 * drive-proxy가 secret을 추가해 Apps Script에 전달한다.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

type DriveUploadResult = { url: string; id: string };
type DriveResponse = { url?: string; id?: string; text?: string; error?: string };

async function callDriveProxy(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<DriveResponse> {
  const { data, error } = await supabase.functions.invoke("drive-proxy", { body });
  if (error) throw new Error(error.message ?? "drive-proxy 호출 실패");
  return data as DriveResponse;
}

/** Drive에 파일 업로드 (base64). */
export async function uploadToDrive(
  supabase: SupabaseClient,
  opts: { name: string; mimeType: string; data: string; folderName: string },
): Promise<DriveUploadResult> {
  const json = await callDriveProxy(supabase, opts);
  if (json.error) throw new Error(json.error);
  if (!json.id) throw new Error("Drive 업로드 실패: id 없음");
  return { url: json.url!, id: json.id! };
}

/** 텍스트(문자열)를 Drive에 업로드. UTF-8 → base64 변환 내장. */
export async function uploadTextToDrive(
  supabase: SupabaseClient,
  opts: { name: string; text: string; folderName: string },
): Promise<DriveUploadResult> {
  const bytes = new TextEncoder().encode(opts.text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return uploadToDrive(supabase, {
    name: opts.name,
    mimeType: "text/plain",
    data: btoa(binary),
    folderName: opts.folderName,
  });
}

/** Drive 파일 텍스트 읽기 (getFileText 액션). */
export async function readDriveFile(supabase: SupabaseClient, fileId: string): Promise<string> {
  const json = await callDriveProxy(supabase, { action: "getFileText", fileId });
  if (json.error) throw new Error(json.error);
  return json.text ?? "";
}

/**
 * activity_logs.transcript 및 재사정 파일 참조 포맷:
 *  - "drive:<fileId>" → Google Drive 파일 ID 참조. readDriveFile()로 텍스트 조회.
 *  - 그 외 문자열    → 값을 직접 본문으로 사용 (레거시 인라인 저장).
 *
 * ⚠️ 이 포맷을 변경하면 기존 DB에 저장된 모든 transcript·extractedTextDriveId 값이
 *    조회 불가 상태가 됨. 포맷 변경 시 기존 레코드 일괄 마이그레이션 필수.
 */
export function isDriveRef(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("drive:");
}
export function driveIdFromRef(ref: string): string {
  return ref.slice("drive:".length);
}

/** Edge Function 오류 응답({ error })에서 사람이 읽을 메시지를 꺼낸다. */
async function edgeErrorMessage(err: unknown): Promise<string> {
  const ctx = (err as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const body = (await ctx.json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      /* 본문이 JSON이 아니면 아래 기본 메시지 사용 */
    }
  }
  return (err as Error | null)?.message ?? "요청 실패";
}

/**
 * 동의서 PDF 받아오기. 파일은 Drive에서 비공개라 링크로 직접 열 수 없으므로,
 * 서버(drive-proxy)가 로그인한 직원의 권한(같은 기관·가입 승인)을 확인한 뒤 내용을 돌려준다.
 * 돌려받은 Blob 주소(url)는 화면에서 보여 준 뒤 URL.revokeObjectURL 로 해제한다.
 */
export async function fetchConsentFile(
  supabase: SupabaseClient,
  clientId: string,
): Promise<{ url: string; name: string }> {
  const { data, error } = await supabase.functions.invoke("drive-proxy", {
    body: { action: "viewConsent", clientId },
  });
  if (error) throw new Error(await edgeErrorMessage(error));
  const res = data as { data?: string; mimeType?: string; name?: string; error?: string } | null;
  if (res?.error) throw new Error(res.error);
  if (!res?.data) throw new Error("동의서 내용을 받지 못했습니다.");
  const bin = atob(res.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: res.mimeType || "application/pdf" }));
  return { url, name: res.name || "AI기능동의서.pdf" };
}
