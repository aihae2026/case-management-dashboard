import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * / → /<slug> 리다이렉트 전용 라우트.
 * 사용자 org의 slug를 조회해 해당 주소로 이동한다.
 */
export const Route = createFileRoute("/_authenticated/")({
  component: IndexRedirect,
});

function IndexRedirect() {
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) { navigate({ to: "/auth", search: { next: "" } }); return; }

      const { data: prof } = await supabase
        .from("profiles")
        .select("org_id, status")
        .eq("id", userRes.user.id)
        .maybeSingle();

      if (!prof?.org_id) { navigate({ to: "/onboarding" }); return; }
      if ((prof as { status?: string }).status === "pending") {
        // 미승인 상태 → $slug 라우트에서 처리하도록 임시 slug로 이동
        // (slug가 없을 수 있으므로 org 조회 후 이동)
      }

      const { data: org } = await supabase
        .from("organizations")
        .select("slug")
        .eq("id", prof.org_id)
        .single();

      // slug 있으면 해당 주소로, 없으면 org id 앞 6자리를 임시 slug로 사용
      const slug = org?.slug || prof.org_id.replace(/-/g, "").slice(0, 6);
      navigate({ to: "/$slug", params: { slug }, search: { tab: undefined }, replace: true });
    })();
  }, [navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
      이동 중...
    </div>
  );
}
