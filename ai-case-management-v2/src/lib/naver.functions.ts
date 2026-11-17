import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * 주소 문자열 → 좌표(위도/경도) 변환 (네이버 클라우드 Geocoding).
 * - Client Secret이 필요하고 CORS로 막히므로 반드시 서버에서 호출한다.
 * - 키(NAVER_MAP_CLIENT_ID / NAVER_MAP_CLIENT_SECRET)가 없거나 실패하면 ok:false 반환
 *   → 클라이언트는 좌표 없이 네이버 지도 주소검색으로 대체(fallback)한다.
 */
export const geocodeAddress = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => {
    const x = d as { address: string };
    if (!x?.address?.trim()) throw new Error("address required");
    return { address: x.address.trim() };
  })
  .handler(
    async ({
      data,
    }): Promise<{ ok: boolean; lat?: number; lng?: number; roadAddress?: string }> => {
      const id = process.env.NAVER_MAP_CLIENT_ID;
      const secret = process.env.NAVER_MAP_CLIENT_SECRET;
      if (!id || !secret) return { ok: false }; // 키 미설정 → 폴백

      try {
        const url = `https://naveropenapi.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(data.address)}`;
        const res = await fetch(url, {
          headers: {
            "x-ncp-apigw-api-key-id": id,
            "x-ncp-apigw-api-key": secret,
            Accept: "application/json",
          },
        });
        if (!res.ok) return { ok: false };
        const json = (await res.json()) as {
          addresses?: { x: string; y: string; roadAddress?: string; jibunAddress?: string }[];
        };
        const a = json.addresses?.[0];
        if (!a) return { ok: false };
        return {
          ok: true,
          lat: Number(a.y),
          lng: Number(a.x),
          roadAddress: a.roadAddress || a.jibunAddress,
        };
      } catch {
        return { ok: false };
      }
    },
  );
