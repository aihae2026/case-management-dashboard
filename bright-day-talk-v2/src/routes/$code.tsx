// /$code 라우트 — 어르신 고유 접속 경로 (예: /0001)
// - short_code로 어르신 존재 여부만 확인한다. session_id는 생년월일 인증을 통과한 뒤에만
//   서버(/api/verify-birth)에서 받아 localStorage에 덮어쓰고 ChatApp에 진입한다.
// - 이 기기가 이미 그 어르신 세션을 갖고 인증을 통과한 적이 있으면 다시 묻지 않는다.
// - DB에 없는 코드는 등록 화면으로 그대로 진입

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChatApp } from "@/components/chat/ChatApp";
import { BirthVerify } from "@/components/chat/BirthVerify";
import { getSessionByCode } from "@/lib/senior.functions";
import { peekSessionId } from "@/lib/session";
import { switchSession } from "@/lib/device-link";
import { clearBirthVerified, isBirthVerified, skipAutoLoginOnce } from "@/lib/birth-auth";

export const Route = createFileRoute("/$code")({
  component: CodeEntry,
});

type Phase = "loading" | "verify_birth" | "chat" | "error";

function CodeEntry() {
  const { code } = Route.useParams();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("loading");

  useEffect(() => {
    let cancelled = false;
    // 숫자(최대 8자리)가 아니면 그냥 일반 ChatApp으로 진입 (register 등)
    if (!/^\d{1,8}$/.test(code)) {
      setPhase("chat");
      return;
    }

    getSessionByCode({ data: { code, currentSessionId: peekSessionId() ?? undefined } })
      .then(({ found, hasBirthCode, ownsSession }) => {
        if (cancelled) return;
        if (!found) {
          // DB에 없는 코드 → 새 등록 흐름. 이 코드로 남아 있던 "기억" 표시는 지워서
          // 첫 화면을 열 때마다 이 주소로 되돌아오지 않게 한다.
          clearBirthVerified(code);
          setPhase("chat");
        } else if (!hasBirthCode) {
          // 생년월일이 등록되지 않은 어르신은 이 방법으로 세션을 받을 수 없다(서버가 session_id를 주지 않는다).
          // 이 기기가 이미 그 어르신 세션이면 그대로 쓰고, 아니면 기기 등록 흐름(담당자 승인)으로 들어간다.
          setPhase("chat");
        } else if (ownsSession && isBirthVerified(code)) {
          // 이 기기가 이미 그 어르신 세션을 갖고 있고 예전에 인증을 통과함 → 다시 묻지 않음
          setPhase("chat");
        } else {
          // 세션 ID는 생년월일을 맞게 입력한 뒤에만 서버에서 받는다
          setPhase("verify_birth");
        }
      })
      .catch(() => { if (!cancelled) setPhase("error"); }); // 서버 오류 → 에러 화면 (fail-closed)
    return () => { cancelled = true; };
  }, [code]); // (R-M5) eslint-disable 제거, code를 deps에 포함

  if (phase === "loading") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <p className="text-lg font-bold text-muted-foreground">잠시만 기다려 주세요…</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-6 text-center">
        <div className="mb-4 text-5xl">😢</div>
        <h1 className="text-xl font-extrabold text-foreground">잠시 연결이 끊겼어요</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          네트워크 오류가 발생했어요.<br />잠시 후 다시 시도해 주세요.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 rounded-2xl bg-primary px-8 py-3 text-base font-bold text-primary-foreground shadow-md"
        >
          다시 시도
        </button>
      </div>
    );
  }

  if (phase === "verify_birth") {
    return (
      <BirthVerify
        shortCode={code}
        onVerified={(verifiedSessionId) => {
          if (verifiedSessionId) switchSession(verifiedSessionId);
          setPhase("chat");
        }}
        onCancel={() => {
          skipAutoLoginOnce(); // 첫 화면으로 돌아왔을 때 다시 자동 입장되지 않게
          void navigate({ to: "/" });
        }}
      />
    );
  }

  return <ChatApp />;
}
