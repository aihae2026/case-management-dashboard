/**
 * Drive 파일을 새 창 대신 앱 안 창(DriveViewerHost)에서 보여 주기 위한 도우미.
 * - 링크 공유된 Drive 파일의 '미리보기' 주소를 앱 창 안에 끼워 넣는다 (PDF·이미지·녹음 모두 지원).
 * - Drive 주소가 아니거나 앱 창이 준비되지 않았으면 예전처럼 새 창으로 연다.
 * - 동의서는 비공개라 이 방식이 아니라 fetchConsentFile(권한 확인 후 서버가 내려줌)을 쓴다.
 */
import { logView, type ViewTarget } from "@/lib/view-log";

const EVENT_NAME = "drive-viewer:open";
let hostReady = false;

export function setDriveViewerReady(ready: boolean): void {
  hostReady = ready;
}

export type DriveViewerRequest = { url: string; title: string };
export { EVENT_NAME as DRIVE_VIEWER_EVENT };

/** Drive/Docs 주소에서 파일 ID를 꺼낸다. 아니면 null */
export function driveFileId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "drive.google.com" && u.hostname !== "docs.google.com") return null;
    const m = u.pathname.match(/\/d\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    return u.searchParams.get("id");
  } catch {
    return null;
  }
}

/** 앱 창 안에 끼워 넣을 미리보기 주소 */
export function drivePreviewUrl(url: string): string | null {
  const id = driveFileId(url);
  return id ? `https://drive.google.com/file/d/${id}/preview` : null;
}

/** Drive 파일 열기: 가능하면 앱 안 창, 아니면 새 창 */
export function openDriveFile(
  url: string | undefined | null,
  title?: string,
  /** 열람 기록용. kind 는 파일 종류(예: "상담 녹음")만 쓰고 파일 이름은 쓰지 않는다. 생략하면 기록하지 않는다. */
  log?: { kind: string; client?: ViewTarget },
): void {
  if (!url) return;
  if (log) logView({ action: "파일 열람", client: log.client, detail: log.kind });
  if (hostReady && drivePreviewUrl(url)) {
    window.dispatchEvent(new CustomEvent<DriveViewerRequest>(EVENT_NAME, { detail: { url, title: title || "파일 보기" } }));
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
