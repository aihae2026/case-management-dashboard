import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PrivacyPolicyContent } from "@/components/PrivacyPolicyContent";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
});

function PrivacyPage() {
  // 로그인한 상태로 열었으면 '앱으로 돌아가기', 아니면 '로그인으로 돌아가기'를 보여 준다
  const [loggedIn, setLoggedIn] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (alive) setLoggedIn(!!data.session);
      } catch {
        /* 확인할 수 없으면 기본(로그인으로) 유지 */
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="max-w-2xl mx-auto">
        {loggedIn ? (
          <a href="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-8">
            <ArrowLeft className="h-4 w-4" />
            앱으로 돌아가기
          </a>
        ) : (
          <Link
            to="/auth"
            search={{ next: "" }}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-8"
          >
            <ArrowLeft className="h-4 w-4" />
            로그인으로 돌아가기
          </Link>
        )}

        <PrivacyPolicyContent />
      </div>
    </div>
  );
}
