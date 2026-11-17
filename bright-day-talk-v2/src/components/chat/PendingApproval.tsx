import { useEffect, useRef, useState } from "react";
import { getRegistrationStatus } from "@/lib/registration.functions";

type Props = {
  registrationId: string;
  orgName: string;
  seniorName: string;
  sessionId: string;
  // 승인되면 서버가 이 등록을 기존 어르신 세션으로 옮겨 둘 수 있어서, 현재 세션 ID를 함께 넘긴다
  onApproved: (sessionId?: string) => void;
  onRejected?: (reason?: string) => void; // (U-1) 거절 콜백
  onLogout: () => void;
};

export function PendingApproval({
  registrationId,
  orgName,
  seniorName,
  onApproved,
  onRejected,
  onLogout,
}: Props) {
  const [dots, setDots] = useState(".");
  const approvedRef = useRef(false); // 중복 호출 방지
  const rejectedRef = useRef(false);
  const onApprovedRef = useRef(onApproved);
  const onRejectedRef = useRef(onRejected);
  useEffect(() => { onApprovedRef.current = onApproved; }, [onApproved]);
  useEffect(() => { onRejectedRef.current = onRejected; }, [onRejected]);

  const triggerApproved = (sessionId?: string) => {
    if (approvedRef.current || rejectedRef.current) return;
    approvedRef.current = true;
    onApprovedRef.current(sessionId);
  };

  const triggerRejected = (reason?: string) => {
    if (approvedRef.current || rejectedRef.current) return;
    rejectedRef.current = true;
    onRejectedRef.current?.(reason);
  };

  // 점 애니메이션
  useEffect(() => {
    const t = setInterval(() => {
      setDots((d) => (d.length >= 3 ? "." : d + "."));
    }, 600);
    return () => clearInterval(t);
  }, []);

  // 3초마다 서버 함수로 승인 여부를 확인한다.
  // (브라우저가 DB를 직접 읽거나 실시간 구독하려면 anon이 등록 테이블을 읽을 수 있어야 해서 서버 경유로 바꿨다)
  useEffect(() => {
    if (!registrationId) return;
    const poll = setInterval(async () => {
      if (approvedRef.current || rejectedRef.current) return;
      try {
        const { status, rejectionReason, sessionId } = await getRegistrationStatus({ data: { registrationId } });
        if (status === "approved") triggerApproved(sessionId ?? undefined);
        else if (status === "rejected") triggerRejected(rejectionReason ?? undefined); // (U-1)
      } catch { /* 네트워크 오류 시 무시 */ }
    }, 3000);

    return () => clearInterval(poll);
  }, [registrationId]);

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-6 py-8 text-center">
      <div className="mb-6 text-6xl">⏳</div>

      <h1 className="text-2xl font-extrabold text-foreground">관리자 승인 대기 중{dots}</h1>
      <p className="mt-3 text-base font-medium text-muted-foreground">
        담당 사회복지사가 등록 요청을 확인하고 있어요.
        <br />
        승인이 완료되면 자동으로 시작됩니다.
      </p>

      {/* 등록 정보 요약 */}
      <div className="mt-6 w-full max-w-sm rounded-2xl bg-card p-4 shadow text-left text-sm">
        <p className="font-bold text-foreground mb-2">등록 정보</p>
        <p className="text-muted-foreground">
          <span className="font-semibold text-foreground">기관</span>{" "}
          {orgName}
        </p>
        <p className="mt-1 text-muted-foreground">
          <span className="font-semibold text-foreground">어르신</span>{" "}
          {seniorName}
        </p>
      </div>

      <p className="mt-6 text-sm text-muted-foreground">
        담당 사회복지사에게 승인을 요청해 주세요.
        <br />
        승인 후 이 화면이 자동으로 변경됩니다.
      </p>

      {/* 업무 시간 안내 (U-1) */}
      <p className="mt-3 rounded-xl bg-muted px-4 py-2.5 text-xs text-muted-foreground leading-relaxed">
        ⏰ 승인은 담당자 업무 시간(평일 오전 9시~오후 6시) 중에 처리돼요.<br />
        이 화면을 닫으셔도 승인되면 자동으로 연결됩니다.
      </p>

      <button
        type="button"
        onClick={onLogout}
        className="mt-8 rounded-xl border-2 border-border bg-background px-5 py-2.5 text-sm font-semibold text-muted-foreground"
      >
        처음으로 돌아가기
      </button>
    </div>
  );
}
