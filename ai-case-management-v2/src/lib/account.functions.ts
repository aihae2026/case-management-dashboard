import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * 회원 탈퇴: 요청자 "본인" 계정만 삭제한다.
 *
 * requireSupabaseAuth 미들웨어가 요청의 Bearer 토큰을 검증해 context.userId(본인 id)를
 * 제공하므로, 클라이언트가 다른 사람의 id 를 넣어 남의 계정을 지우는 것은 불가능하다.
 *
 * 삭제 방법: SUPABASE_SERVICE_ROLE_KEY 가 있으면 Admin API 로 직접 삭제,
 *            없으면 Supabase DB의 security definer RPC delete_user() 로 삭제.
 *
 * auth.users 를 삭제하면:
 *  - profiles 는 ON DELETE CASCADE 로 함께 삭제되고,
 *  - clients.worker_id / organizations.created_by 는 ON DELETE SET NULL 이라
 *    기관·대상자 데이터는 그대로 보존된다(담당자 연결만 해제).
 *
 * Supabase SQL Editor에서 아래 함수를 한 번 실행해 두어야 RPC 방식이 동작합니다:
 * ---
 * create or replace function public.delete_user()
 * returns void language plpgsql security definer set search_path = public as $$
 * begin
 *   delete from auth.users where id = auth.uid();
 * end;
 * $$;
 * ---
 */
export const deleteAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as { userId: string; supabase: import("@supabase/supabase-js").SupabaseClient };
    const userId = ctx.userId;
    if (!userId) throw new Error("Unauthorized");

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (serviceKey) {
      // Service role key 있으면 Admin API 사용 (더 확실)
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (error) throw new Error(error.message);
    } else {
      // Service role key 없으면 security definer RPC 호출 (auth.uid() = 본인만 삭제)
      const { error } = await ctx.supabase.rpc("delete_user");
      if (error) throw new Error(`탈퇴 실패: ${error.message}. Supabase SQL Editor에서 delete_user() 함수를 생성했는지 확인하세요.`);
    }
    return { ok: true };
  });
