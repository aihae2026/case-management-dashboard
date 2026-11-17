import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth/callback")({
  component: AuthCallback,
});

function AuthCallback() {
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let settled = false;

    // sessionStorage에서 로그인 후 이동할 경로 읽기 (없으면 /)
    let next = "/";
    try {
      next = sessionStorage.getItem("auth_next") || "/";
      sessionStorage.removeItem("auth_next");
    } catch { /* ignore */ }

    const go = () => {
      if (settled) return;
      settled = true;
      window.location.replace(next);
    };

    // URL에 에러 파라미터가 있으면 바로 표시
    const params = new URLSearchParams(window.location.search);
    const urlError = params.get("error_description") || params.get("error");
    if (urlError) {
      setErrorMsg(decodeURIComponent(urlError));
      return;
    }

    // supabase-js v2가 PKCE code를 자동으로 교환하고 SIGNED_IN 이벤트를 발생시킴.
    // 수동으로 exchangeCodeForSession을 호출하면 코드가 두 번 사용되어 에러 발생.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || (event === "INITIAL_SESSION" && session)) {
        subscription.unsubscribe();
        go();
      }
    });

    // 이미 세션이 있는 경우 즉시 이동
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        subscription.unsubscribe();
        go();
      }
    });

    // 15초 타임아웃
    const timer = setTimeout(() => {
      if (!settled) setErrorMsg("로그인 응답이 없어요. 다시 시도해 주세요.");
    }, 15000);

    return () => { subscription.unsubscribe(); clearTimeout(timer); };
  }, []);

  if (errorMsg) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-6 text-center">
        <p className="text-xl font-bold text-foreground">로그인에 실패했어요</p>
        <p className="mt-2 rounded-xl bg-destructive/10 px-4 py-2 text-sm text-destructive">{errorMsg}</p>
        <button
          type="button"
          onClick={() => window.history.back()}
          className="mt-6 rounded-xl border-2 border-border bg-background px-5 py-2.5 text-sm font-semibold text-muted-foreground"
        >
          돌아가기
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background">
      <div className="text-center">
        <p className="text-xl font-bold text-foreground">로그인 확인 중…</p>
        <p className="mt-2 text-sm text-muted-foreground">잠시만 기다려 주세요</p>
      </div>
    </div>
  );
}
