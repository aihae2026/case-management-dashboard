import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * 요청한 사람(서명 장소)의 접속 IP를 서버가 요청 헤더에서 읽어 돌려준다.
 * 동의서 서명 증빙용이며, 외부 IP 조회 서비스를 호출하지 않는다. 헤더가 없으면(로컬 개발 등) null.
 */
export const getClientIp = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ ip: string | null }> => {
    const h = getRequest().headers;
    const raw = h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "";
    const ip = raw.split(",")[0].trim();
    return { ip: ip || null };
  });
