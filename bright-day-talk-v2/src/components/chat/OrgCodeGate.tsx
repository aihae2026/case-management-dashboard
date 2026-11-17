import { useState } from "react";
import { verifySeniorLogin } from "@/lib/senior.functions";

// First-run screen: the caregiver (or elder) enters the organization access
// code and the elder's basic info on a single screen. We verify the info
// against the case-management system (read-only) and only unlock the chat when
// the elder is actually registered there.
export function OrgCodeGate({
  sessionId,
  initialSeniorName,
  initialPhone,
  onComplete,
}: {
  sessionId: string;
  initialSeniorName: string;
  initialPhone: string;
  onComplete: (data: {
    orgCode: string;
    orgName: string;
    seniorName: string;
    phone: string;
    keepLoggedIn: boolean;
  }) => void;
}) {
  const [code, setCode] = useState("");
  const [seniorName, setSeniorName] = useState(initialSeniorName);
  const [phone, setPhone] = useState(initialPhone);
  const [keepLoggedIn, setKeepLoggedIn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    const org = code.trim().toUpperCase();
    const name = seniorName.trim();
    if (!org) {
      setError("기관코드를 입력해 주세요.");
      return;
    }
    if (!name) {
      setError("어르신 성함을 적어 주세요.");
      return;
    }
    if (phone.replace(/\D/g, "").length < 9) {
      setError("전화번호를 정확히 적어 주세요.");
      return;
    }
    setError(null);
    setChecking(true);
    try {
      const result = await verifySeniorLogin({
        data: { sessionId, orgCode: org, name, phone: phone.trim() },
      });
      if (result.ok) {
        onComplete({
          orgCode: org,
          orgName: result.orgName ?? "",
          seniorName: result.seniorName ?? name,
          phone: phone.trim(),
          keepLoggedIn,
        });
        return;
      }
      // 등록된 어르신만 사용할 수 있도록 차단하고, 이유에 맞는 안내를 보여준다.
      if (result.reason === "org_not_found") {
        setError("기관코드가 올바르지 않아요.\n복지관에서 안내받은 코드를 다시 확인해 주세요.");
      } else if (result.reason === "client_not_found") {
        setError(
          "복지관에 등록된 어르신 정보를 찾지 못했어요.\n성함과 전화번호를 다시 확인해 주세요.",
        );
      } else {
        setError("지금은 연결이 어려워요. 잠시 후 다시 시도해 주세요.");
      }
    } catch {
      setError("지금은 연결이 어려워요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background px-5 py-8">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-extrabold text-foreground">안녕하세요, 복순이에요</h1>
          <p className="mt-1 text-base font-medium text-muted-foreground">
            만나서 반가워요 😊 아래 정보를 입력해 주세요
          </p>
        </div>

        <div className="rounded-3xl bg-card p-6 shadow-lg">
          <label className="mb-1.5 block text-base font-bold text-foreground">기관코드</label>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="예) ABCD1234"
            autoFocus
            maxLength={16}
            disabled={checking}
            className="mb-4 w-full rounded-2xl border-2 border-border bg-background px-4 py-3 text-center text-lg font-extrabold uppercase tracking-widest text-foreground outline-none focus:border-ring disabled:opacity-60"
          />

          <label className="mb-1.5 block text-base font-bold text-foreground">어르신 성함</label>
          <input
            type="text"
            value={seniorName}
            onChange={(e) => setSeniorName(e.target.value)}
            placeholder="예) 김순자"
            maxLength={20}
            disabled={checking}
            className="mb-4 w-full rounded-2xl border-2 border-border bg-background px-4 py-3 text-lg font-semibold text-foreground outline-none focus:border-ring disabled:opacity-60"
          />

          <label className="mb-1.5 block text-base font-bold text-foreground">전화번호</label>
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !checking) void submit(); }}
            placeholder="010-1234-5678"
            maxLength={20}
            disabled={checking}
            className="mb-4 w-full rounded-2xl border-2 border-border bg-background px-4 py-3 text-lg font-semibold text-foreground outline-none focus:border-ring disabled:opacity-60"
          />

          {/* 로그인 유지 */}
          <button
            type="button"
            onClick={() => setKeepLoggedIn((v) => !v)}
            disabled={checking}
            aria-pressed={keepLoggedIn}
            className="mb-4 flex w-full items-center gap-3 rounded-2xl border-2 border-border bg-background px-4 py-3 text-left active:scale-[0.99] disabled:opacity-60"
          >
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-lg border-2 text-base font-extrabold ${
                keepLoggedIn
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-transparent"
              }`}
            >
              ✓
            </span>
            <span className="text-base font-bold text-foreground">로그인 유지</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {keepLoggedIn ? "다음에 자동 로그인" : "이번만 로그인"}
            </span>
          </button>

          {error && (
            <p className="mb-3 whitespace-pre-line rounded-xl bg-destructive/10 px-3 py-2 text-center text-sm font-semibold text-destructive">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={checking}
            className="w-full rounded-2xl bg-primary px-6 py-4 text-lg font-extrabold text-primary-foreground active:scale-[0.98] disabled:opacity-60"
          >
            {checking ? "확인하는 중이에요…" : "시작하기"}
          </button>
          <p className="mt-4 text-center text-xs text-muted-foreground">
            복지관에 등록된 기관코드·성함·전화번호와 같아야 시작할 수 있어요.
          </p>
        </div>
      </div>
    </div>
  );
}
