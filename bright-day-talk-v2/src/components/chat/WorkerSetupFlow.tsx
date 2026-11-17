import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { createRegistration } from "@/lib/registration.functions";
import { verifySeniorLogin } from "@/lib/senior.functions";

type Props = {
  sessionId: string;
  onRegistered: (registrationId: string) => void;
};

type Step = 1 | 2;

export function WorkerSetupFlow({ sessionId, onRegistered }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [orgCode, setOrgCode] = useState("");
  const [orgName, setOrgName] = useState("");
  const [seniorName, setSeniorName] = useState("");
  const [seniorPhone, setSeniorPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // ── Step 1: 기관코드 확인 ──────────────────────────
  const handleStep1 = () => {
    const code = orgCode.trim().toUpperCase();
    if (!code) { setError("기관코드를 입력해 주세요."); return; }
    setOrgCode(code);
    setError(null);
    setStep(2);
  };

  // ── Step 2: 어르신 정보 확인 후 등록 요청 ────────────
  const handleStep2 = async () => {
    const name = seniorName.trim();
    const phone = seniorPhone.trim();
    if (!name) { setError("어르신 성함을 입력해 주세요."); return; }
    if (phone.replace(/\D/g, "").length < 9) {
      setError("전화번호를 정확히 입력해 주세요."); return;
    }
    setError(null);
    setLoading(true);
    try {
      // 통합사례관리 연동으로 어르신 정보 확인
      const verified = await verifySeniorLogin({
        data: { sessionId, orgCode, name, phone },
      });
      if (!verified.ok) {
        if (verified.reason === "org_not_found") {
          setError("기관코드가 올바르지 않아요.\n복지관에서 안내받은 코드를 다시 확인해 주세요.");
        } else if (verified.reason === "client_not_found") {
          setError("등록된 어르신 정보를 찾지 못했어요.\n성함과 전화번호를 다시 확인해 주세요.");
        } else {
          setError("지금은 연결이 어려워요. 잠시 후 다시 시도해 주세요.");
        }
        return;
      }
      const resolvedOrgName = verified.orgName ?? orgCode;
      const resolvedName = verified.seniorName ?? name;
      setOrgName(resolvedOrgName);
      setSeniorName(resolvedName);

      // 등록 요청 생성
      const result = await createRegistration({
        data: {
          sessionId,
          orgCode,
          orgName: resolvedOrgName,
          seniorName: resolvedName,
          seniorPhone: phone,
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        },
      });
      onRegistered(result.id);
    } catch {
      setError("지금은 연결이 어려워요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background px-5 py-8">
      <div className="mx-auto w-full max-w-md">
        {/* 헤더 */}
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-extrabold text-foreground">복순이 기기 등록</h1>
          <p className="mt-1 text-base font-medium text-muted-foreground">
            {step === 1 && "담당 기관 정보를 입력해 주세요"}
            {step === 2 && "어르신 정보를 확인해 주세요"}
          </p>
        </div>

        {/* 단계 표시 */}
        <div className="mb-6 flex items-center justify-center gap-2">
          {([1, 2] as const).map((s) => (
            <div
              key={s}
              className={`flex size-8 items-center justify-center rounded-full text-sm font-bold transition-colors ${
                s === step
                  ? "bg-primary text-primary-foreground"
                  : s < step
                  ? "bg-primary/40 text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {s < step ? "✓" : s}
            </div>
          ))}
        </div>

        <div className="rounded-3xl bg-card p-6 shadow-lg">
          {/* ── STEP 1 ── */}
          {step === 1 && (
            <>
              <label className="mb-1.5 block text-base font-bold text-foreground">기관코드</label>
              <input
                type="text"
                value={orgCode}
                onChange={(e) => setOrgCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && handleStep1()}
                placeholder="예) JNNOIN2024"
                autoFocus
                maxLength={16}
                className="mb-4 w-full rounded-2xl border-2 border-border bg-background px-4 py-3 text-center text-lg font-extrabold uppercase tracking-widest text-foreground outline-none focus:border-ring"
              />
              {error && <ErrorBox message={error} />}
              <button
                type="button"
                onClick={handleStep1}
                className="w-full rounded-2xl bg-primary px-6 py-4 text-lg font-extrabold text-primary-foreground active:scale-[0.98]"
              >
                다음
              </button>
            </>
          )}

          {/* ── STEP 2 ── */}
          {step === 2 && (
            <>
              <p className="mb-4 rounded-xl bg-muted px-3 py-2 text-center text-sm font-semibold text-muted-foreground">
                기관코드: <span className="text-foreground">{orgCode}</span>
              </p>
              <label className="mb-1.5 block text-base font-bold text-foreground">어르신 성함</label>
              <input
                type="text"
                value={seniorName}
                onChange={(e) => setSeniorName(e.target.value)}
                placeholder="예) 김순자"
                autoFocus
                maxLength={20}
                disabled={loading}
                className="mb-4 w-full rounded-2xl border-2 border-border bg-background px-4 py-3 text-lg font-semibold text-foreground outline-none focus:border-ring disabled:opacity-60"
              />
              <label className="mb-1.5 block text-base font-bold text-foreground">전화번호</label>
              <input
                type="tel"
                inputMode="tel"
                value={seniorPhone}
                onChange={(e) => setSeniorPhone(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !loading && handleStep2()}
                placeholder="010-1234-5678"
                maxLength={20}
                disabled={loading}
                className="mb-4 w-full rounded-2xl border-2 border-border bg-background px-4 py-3 text-lg font-semibold text-foreground outline-none focus:border-ring disabled:opacity-60"
              />
              {error && <ErrorBox message={error} />}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setError(null); setStep(1); }}
                  disabled={loading}
                  className="flex-1 rounded-2xl border-2 border-border bg-background px-4 py-4 font-bold text-foreground disabled:opacity-60"
                >
                  이전
                </button>
                <button
                  type="button"
                  onClick={handleStep2}
                  disabled={loading}
                  className="flex-[2] rounded-2xl bg-primary px-6 py-4 text-lg font-extrabold text-primary-foreground active:scale-[0.98] disabled:opacity-60"
                >
                  {loading ? "확인 중…" : "승인 요청"}
                </button>
              </div>
            </>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          복지관에 등록된 어르신만 서비스를 이용할 수 있어요
        </p>
        <p className="mt-2 text-center text-xs text-muted-foreground/70">
          <Link to="/privacy" className="underline underline-offset-2 hover:text-muted-foreground">
            개인정보처리방침
          </Link>
        </p>
      </div>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <p className="mb-3 whitespace-pre-line rounded-xl bg-destructive/10 px-3 py-2 text-center text-sm font-semibold text-destructive">
      {message}
    </p>
  );
}
