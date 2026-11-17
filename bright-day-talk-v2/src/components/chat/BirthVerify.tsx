import { useEffect, useRef, useState } from "react";
import companionAvatar from "@/assets/companion-avatar.png";
import { setBirthVerified } from "@/lib/birth-auth";
import { BrowserNotice } from "./BrowserNotice";

// 생년월일 6자리(YYMMDD) 인증 화면
// shortCode가 있으면 → POST /api/verify-birth { shortCode, birthCode }

type Props = {
  shortCode: string;
  onVerified: (sessionId: string | null) => void;
  onCancel?: () => void; // 뒤로가기 (선택)
};

export function BirthVerify({ shortCode, onVerified, onCancel }: Props) {
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [keepLoggedIn, setKeepLoggedIn] = useState(true); // 기본값: 영구 유지
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [shaking, setShaking] = useState(false);
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // refs — 훅 규칙: 개별 선언
  const r0 = useRef<HTMLInputElement>(null);
  const r1 = useRef<HTMLInputElement>(null);
  const r2 = useRef<HTMLInputElement>(null);
  const r3 = useRef<HTMLInputElement>(null);
  const r4 = useRef<HTMLInputElement>(null);
  const r5 = useRef<HTMLInputElement>(null);
  const inputRefs = [r0, r1, r2, r3, r4, r5];

  // 마운트 시 첫 번째 입력칸 자동 포커스
  useEffect(() => {
    r0.current?.focus();
  }, []);

  // shake 타이머 언마운트 정리 (R-M3)
  useEffect(() => () => { if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current); }, []);

  const shake = () => {
    if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
    setShaking(true);
    shakeTimerRef.current = setTimeout(() => setShaking(false), 500);
  };

  const handleDigit = (idx: number, value: string) => {
    const char = value.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[idx] = char;
    setDigits(next);
    setError("");
    if (char && idx < 5) inputRefs[idx + 1].current?.focus();
  };

  const handleKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) {
      inputRefs[idx - 1].current?.focus();
    }
    if (e.key === "Enter") void submit();
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!pasted) return;
    e.preventDefault();
    const next = ["", "", "", "", "", ""];
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setDigits(next);
    setError("");
    inputRefs[Math.min(pasted.length, 5)].current?.focus();
  };

  const submit = async () => {
    const code = digits.join("");
    if (code.length < 6) {
      setError("생년월일 여섯 자리를 모두 입력해 주세요.");
      shake();
      const firstEmpty = digits.findIndex((d) => !d);
      inputRefs[firstEmpty === -1 ? 5 : firstEmpty].current?.focus();
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/verify-birth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortCode, birthCode: code }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: string; sessionId?: string }
        | null;

      if (!data) {
        setError("서버 오류가 발생했어요. 잠시 후 다시 시도해 주세요.");
        shake();
        return;
      }

      if (data.ok) {
        setBirthVerified(shortCode, keepLoggedIn);
        onVerified(data.sessionId ?? null);
        return;
      }

      if (data.error === "not_found") {
        setError("어르신 정보를 찾을 수 없어요.\n담당 사회복지사에게 문의해 주세요.");
      } else if (data.error === "ambiguous") {
        setError("같은 생년월일을 가진 어르신이 여러 명이에요.\n담당 사회복지사에게 고유번호를 확인해 주세요.");
      } else if (data.error === "wrong_birth_code") {
        setError("생년월일이 맞지 않아요. 다시 확인해 주세요.");
      } else if (data.error === "too_many_requests") {
        setError("여러 번 시도하셨어요.\n잠시 쉬었다가 다시 해 주세요.");
      } else {
        setError("확인 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.");
      }
      shake();
    } catch {
      setError("연결 오류가 발생했어요. 잠시 후 다시 시도해 주세요.");
      shake();
    } finally {
      setLoading(false);
    }
  };

  const groupAfter = new Set([1, 3]); // YY·MM·DD

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-5 py-10 lg:bg-gradient-to-br lg:from-brand/20 lg:via-background lg:to-brand/10">
      <div className="flex w-full max-w-sm flex-col items-center lg:rounded-3xl lg:bg-background lg:px-10 lg:py-12 lg:shadow-2xl">

        <BrowserNotice />

        {/* 아바타 */}
        <div
          className="mb-2 size-28 overflow-hidden rounded-full bg-secondary shadow-lg ring-4 ring-brand/30"
          style={{ animation: "avatar-bob 3.2s ease-in-out infinite" }}
        >
          <img src={companionAvatar} alt="복순이" className="size-full object-cover" />
        </div>

        <h1 className="mb-1 text-2xl font-extrabold text-foreground">복순이 말벗 서비스</h1>
        <p className="mb-6 text-center text-[0.92rem] leading-relaxed text-muted-foreground">
          안전한 이용을 위해 <strong className="text-foreground">생년월일</strong>을<br />
          입력해 주세요.
        </p>

        {/* 형식 안내 */}
        <div className="mb-4 flex gap-4 text-xs text-muted-foreground/80">
          <span>연도 2자리</span><span>·</span>
          <span>월 2자리</span><span>·</span>
          <span>일 2자리</span>
        </div>

        {/* 6자리 입력 */}
        <div className={`mb-1 flex items-center justify-center gap-1.5 ${shaking ? "animate-[wiggle_0.45s_ease-in-out]" : ""}`}>
          {digits.map((d, i) => (
            <span key={i} className="flex items-center gap-1.5">
              <input
                ref={inputRefs[i]}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={d}
                onPaste={handlePaste}
                onChange={(e) => handleDigit(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                className={`size-[clamp(2.4rem,11vw,3rem)] rounded-xl border-2 bg-background text-center text-2xl font-extrabold text-foreground outline-none transition
                  ${d ? "border-primary shadow-md" : "border-border"}
                  focus:border-primary focus:shadow-md`}
                aria-label={`생년월일 ${i + 1}번째 자리`}
              />
              {groupAfter.has(i) && (
                <span className="text-lg font-bold text-muted-foreground/50">·</span>
              )}
            </span>
          ))}
        </div>

        <p className="mb-5 text-center text-xs text-muted-foreground/60">
          예) 1950년 3월 15일 → <span className="font-mono font-semibold">50 03 15</span>
        </p>

        {/* 로그인 유지 체크박스 */}
        <label className="mb-4 flex cursor-pointer items-center gap-3 rounded-2xl border-2 border-border bg-background px-4 py-3 transition active:scale-[0.98] has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5">
          <input
            type="checkbox"
            checked={keepLoggedIn}
            onChange={(e) => setKeepLoggedIn(e.target.checked)}
            className="size-6 cursor-pointer accent-primary"
          />
          <div>
            <p className="text-sm font-bold text-foreground">이 기기에서 로그인 유지</p>
            <p className="text-xs text-muted-foreground">다음부터 생년월일 입력 생략</p>
          </div>
        </label>

        {error && (
          <p className="mb-3 whitespace-pre-line text-center text-sm font-semibold text-destructive">{error}</p>
        )}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={loading}
          className="w-full rounded-2xl bg-primary py-4 text-lg font-extrabold text-primary-foreground shadow-md transition active:scale-[0.98] disabled:opacity-60"
        >
          {loading ? "확인 중…" : "입장하기 →"}
        </button>

        {/* 뒤로가기 */}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="mt-3 w-full rounded-2xl py-2.5 text-sm font-semibold text-muted-foreground transition active:scale-[0.98]"
          >
            ← 처음으로 돌아가기
          </button>
        )}
      </div>

      <style>{`
        @keyframes wiggle {
          0%,100% { transform: translateX(0); }
          20%      { transform: translateX(-8px); }
          40%      { transform: translateX(8px); }
          60%      { transform: translateX(-6px); }
          80%      { transform: translateX(6px); }
        }
      `}</style>
    </div>
  );
}
