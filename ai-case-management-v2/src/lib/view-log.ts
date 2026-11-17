import { supabase } from "@/integrations/supabase/client";
import { detectDevice, resolveIp, type IpFetcher } from "@/lib/access-log";

/**
 * 열람 기록(view_log): 누가 어떤 대상자를 어떤 방식으로 열람했는지 남긴다.
 * - 앱이 화면에서 연 행동(대상자 상세 열기, 인쇄, 동의서·파일·녹음 열기, AI 리포트 생성)을 기록한다.
 * - 대상자 이름은 저장하지 않고 번호와 id만 남긴다.
 * - 기록은 화면을 기다리게 하지 않고, 실패해도 업무 화면은 그대로 동작한다(팝업 차단을 피하려고 await 하지 않는다).
 * - 같은 사람이 같은 대상자·같은 행동을 5분 안에 반복하면 한 번만 남긴다.
 */

export type ViewLogContext = {
  orgId: string;
  userId: string;
  userName: string | null;
  getIp: IpFetcher;
};

export type ViewTarget = { id?: string | null; client_code?: string | null } | null | undefined;

const DEDUPE_MS = 5 * 60 * 1000;
const recent = new Map<string, number>();
let ctx: ViewLogContext | null = null;
let disabled = false; // 테이블이 없으면(DB 반영 전) 더 시도하지 않는다

/** 로그인한 사용자 정보를 한 번 등록해 둔다(화면 어디서든 logView 를 부를 수 있게). 로그아웃하면 null. */
export function setViewLogContext(c: ViewLogContext | null) {
  ctx = c;
  if (!c) recent.clear();
}

export function logView(p: { action: string; client?: ViewTarget; detail?: string | null }): void {
  if (typeof window === "undefined" || !ctx || disabled) return;
  const c = ctx;
  const clientId = p.client?.id ?? null;
  const key = `${c.userId}|${clientId ?? ""}|${p.action}|${p.detail ?? ""}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return;
  recent.set(key, now);
  if (recent.size > 500) {
    for (const [k, t] of recent) if (now - t >= DEDUPE_MS) recent.delete(k);
  }
  void send(c, {
    action: p.action,
    detail: p.detail ?? null,
    client_id: clientId,
    client_code: p.client?.client_code ?? null,
  });
}

async function send(
  c: ViewLogContext,
  row: { action: string; detail: string | null; client_id: string | null; client_code: string | null },
) {
  try {
    const ip = await resolveIp(c.getIp);
    const payload = {
      org_id: c.orgId,
      user_id: c.userId,
      user_name: c.userName,
      device: detectDevice(),
      ...row,
      ...(ip ? { ip } : {}),
    };
    const { error } = await supabase.from("view_log").insert(payload);
    if (error) {
      // 테이블이 아직 없으면(42P01·PGRST205) 이번 접속에서는 더 시도하지 않는다
      if (error.code === "42P01" || error.code === "PGRST205") disabled = true;
      console.warn("[view_log] 열람 기록 실패:", error.message, error.code);
    }
  } catch (e) {
    console.warn("[view_log] 열람 기록 오류:", e);
  }
}
