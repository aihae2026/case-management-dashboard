import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import companionAvatar from "@/assets/companion-avatar.png";
import { consumeSkipAutoLogin, findRememberedCode, setBirthVerified } from "@/lib/birth-auth";
import { switchSession } from "@/lib/device-link";
import { BrowserNotice } from "@/components/chat/BrowserNotice";

type StaffMember = { name: string; title: string; phone: string };
const DEFAULT_CONTACTS: StaffMember[] = [
  { name: "담당 사회복지사", title: "팀장",       phone: "" },
  { name: "담당 사회복지사", title: "사회복지사", phone: "" },
];

export const Route = createFileRoute("/")({
  component: Landing,
});

type Flow = "choice" | "existing";

function Landing() {
  const navigate = useNavigate();
  const [flow, setFlow] = useState<Flow>("choice");
  // 고유번호 4자리
  const [shortDigits, setShortDigits] = useState(["", "", "", ""]);
  // 생년월일 6자리 (YYMMDD)
  const [birthDigits, setBirthDigits] = useState(["", "", "", "", "", ""]);
  const [error, setError] = useState("");
  const [shaking, setShaking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [keepLoggedIn, setKeepLoggedIn] = useState(true); // 기본값: 영구 유지
  const [staffContacts, setStaffContacts] = useState<StaffMember[]>(DEFAULT_CONTACTS);
  const [redirecting, setRedirecting] = useState(false);

  // "로그인 상태 유지"로 저장된 고유번호가 있으면 로그인 화면을 건너뛰고 바로 들어간다.
  // (홈 화면 아이콘은 "/"로 열리므로, 이 처리가 없으면 매번 다시 입력해야 한다)
  useEffect(() => {
    if (consumeSkipAutoLogin()) return;
    const code = findRememberedCode();
    if (!code) return;
    setRedirecting(true);
    void navigate({ to: "/$code", params: { code }, replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch("/api/staff-contacts")
      .then((r) => r.json())
      .then((d: StaffMember[]) => setStaffContacts(d))
      .catch(() => {});
  }, []);

  // refs (훅 규칙: 개별 선언) — 0~3: 고유번호, 4~9: 생년월일
  const s0 = useRef<HTMLInputElement>(null);
  const s1 = useRef<HTMLInputElement>(null);
  const s2 = useRef<HTMLInputElement>(null);
  const s3 = useRef<HTMLInputElement>(null);
  const b0 = useRef<HTMLInputElement>(null);
  const b1 = useRef<HTMLInputElement>(null);
  const b2 = useRef<HTMLInputElement>(null);
  const b3 = useRef<HTMLInputElement>(null);
  const b4 = useRef<HTMLInputElement>(null);
  const b5 = useRef<HTMLInputElement>(null);
  const shortRefs = [s0, s1, s2, s3];
  const birthRefs = [b0, b1, b2, b3, b4, b5];
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // shake 타이머 언마운트 정리 (R-M3 동일 패턴)
  useEffect(() => () => { if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current); }, []);

  const shake = () => {
    if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
    setShaking(true);
    shakeTimerRef.current = setTimeout(() => setShaking(false), 500);
  };

  // ── 고유번호 입력 핸들러 ──
  const handleShort = (idx: number, value: string) => {
    const char = value.replace(/\D/g, "").slice(-1);
    const next = [...shortDigits];
    next[idx] = char;
    setShortDigits(next);
    setError("");
    if (char) {
      if (idx < 3) shortRefs[idx + 1].current?.focus();
      else birthRefs[0].current?.focus(); // 마지막 자리 → 생년월일 첫 칸으로
    }
  };

  const handleShortKey = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !shortDigits[idx] && idx > 0) {
      shortRefs[idx - 1].current?.focus();
    }
    if (e.key === "Enter") void enter();
  };

  const handleShortPaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "");
    if (!pasted) return;
    e.preventDefault();
    const sc = pasted.slice(0, 4);
    const bc = pasted.slice(4, 10);
    const nextS = ["", "", "", ""];
    for (let i = 0; i < sc.length; i++) nextS[i] = sc[i];
    setShortDigits(nextS);
    if (bc.length > 0) {
      const nextB = ["", "", "", "", "", ""];
      for (let i = 0; i < bc.length; i++) nextB[i] = bc[i];
      setBirthDigits(nextB);
      const focusIdx = Math.min(bc.length, 5);
      birthRefs[focusIdx].current?.focus();
    } else {
      const focusIdx = Math.min(sc.length, 3);
      shortRefs[focusIdx].current?.focus();
    }
    setError("");
  };

  // ── 생년월일 입력 핸들러 ──
  const handleBirth = (idx: number, value: string) => {
    const char = value.replace(/\D/g, "").slice(-1);
    const next = [...birthDigits];
    next[idx] = char;
    setBirthDigits(next);
    setError("");
    if (char && idx < 5) birthRefs[idx + 1].current?.focus();
  };

  const handleBirthKey = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !birthDigits[idx]) {
      if (idx > 0) birthRefs[idx - 1].current?.focus();
      else shortRefs[3].current?.focus(); // 첫 칸에서 백스페이스 → 고유번호 마지막 칸
    }
    if (e.key === "Enter") void enter();
  };

  const handleBirthPaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!pasted) return;
    e.preventDefault();
    const next = ["", "", "", "", "", ""];
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setBirthDigits(next);
    setError("");
    const focusIdx = Math.min(pasted.length, 5);
    birthRefs[focusIdx].current?.focus();
  };

  // ── 제출 ──
  const enter = async () => {
    const shortCode = shortDigits.join("").padStart(4, "0");
    const birthCode = birthDigits.join("");

    if (shortDigits.some((d) => !d)) {
      setError("고유번호 4자리를 입력해 주세요.");
      shake();
      shortRefs[shortDigits.findIndex((d) => !d)].current?.focus();
      return;
    }
    if (birthCode.length < 6) {
      setError("생년월일 6자리를 모두 입력해 주세요.");
      shake();
      const firstEmpty = birthDigits.findIndex((d) => !d);
      birthRefs[firstEmpty === -1 ? 5 : firstEmpty].current?.focus();
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/verify-birth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortCode, birthCode }),
      });
      const data = (await res.json()) as { ok: boolean; skipped?: boolean; error?: string; sessionId?: string };

      if (data.ok) {
        setBirthVerified(shortCode, keepLoggedIn);
        // 생년월일을 확인한 직후에만 이 기기를 그 어르신 세션으로 바꾼다
        if (data.sessionId) switchSession(data.sessionId);
        void navigate({ to: "/$code", params: { code: shortCode } });
        return;
      }

      if (data.error === "not_found") {
        setError("고유번호를 찾을 수 없어요.\n담당 사회복지사에게 문의해 주세요.");
      } else if (data.error === "wrong_birth_code") {
        setError("생년월일이 맞지 않아요. 다시 확인해 주세요.");
      } else if (data.error === "too_many_requests") {
        setError("여러 번 시도하셨어요.\n잠시 쉬었다가 다시 해 주세요.");
      } else {
        setError("정보를 확인할 수 없어요. 담당 사회복지사에게 문의해 주세요.");
      }
      shake();
    } catch {
      setError("연결 오류가 발생했어요. 잠시 후 다시 시도해 주세요.");
      shake();
    } finally {
      setLoading(false);
    }
  };

  const goExisting = () => {
    setFlow("existing");
    setTimeout(() => shortRefs[0].current?.focus(), 50);
  };

  const birthGroupAfter = new Set([1, 3]); // YY·MM·DD 구분

  if (redirecting) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <p className="text-lg font-bold text-muted-foreground">잠시만 기다려 주세요…</p>
      </div>
    );
  }

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
        <p className="mb-8 text-center text-[0.92rem] leading-relaxed text-muted-foreground">
          안녕하세요! 어르신의 든든한 말벗,<br />
          <strong className="text-foreground">복순이</strong>예요 😊
        </p>

        {flow === "choice" ? (
          /* ─── 선택 화면 ─── */
          <div className="flex w-full flex-col gap-3">
            <button
              type="button"
              onClick={goExisting}
              className="w-full rounded-2xl bg-primary py-4 text-lg font-extrabold text-primary-foreground shadow-md transition active:scale-[0.98]"
            >
              🔑 접속하기
            </button>
            <button
              type="button"
              onClick={() => void navigate({ to: "/$code", params: { code: "register" } })}
              className="w-full rounded-2xl border-2 border-primary/40 bg-background py-4 text-lg font-extrabold text-primary transition active:scale-[0.98]"
            >
              🌱 처음 오세요? 새로 등록하기
            </button>
          </div>
        ) : (
          /* ─── 기존 이용자: 고유번호 + 생년월일 입력 ─── */
          <div className={`w-full ${shaking ? "animate-[wiggle_0.45s_ease-in-out]" : ""}`}>

            {/* ① 고유번호 */}
            <p className="mb-2 text-center text-[0.85rem] font-semibold text-muted-foreground">
              복지관에서 받은 <strong className="text-foreground">고유번호 4자리</strong>
            </p>
            <div className="mb-4 flex justify-center gap-2">
              {shortDigits.map((d, i) => (
                <input
                  key={i}
                  ref={shortRefs[i]}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={d}
                  onPaste={handleShortPaste}
                  onChange={(e) => handleShort(i, e.target.value)}
                  onKeyDown={(e) => handleShortKey(i, e)}
                  className={`size-[clamp(3rem,16vw,3.6rem)] rounded-2xl border-2 bg-background text-center text-3xl font-extrabold text-foreground outline-none transition
                    ${d ? "border-primary shadow-md" : "border-border"}
                    focus:border-primary focus:shadow-md`}
                  aria-label={`고유번호 ${i + 1}번째 자리`}
                />
              ))}
            </div>

            {/* ② 생년월일 */}
            <p className="mb-2 text-center text-[0.85rem] font-semibold text-muted-foreground">
              어르신 <strong className="text-foreground">생년월일 6자리</strong>
            </p>
            <div className="mb-1 flex items-center justify-center gap-1">
              {birthDigits.map((d, i) => (
                <span key={i} className="flex items-center gap-1">
                  <input
                    ref={birthRefs[i]}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={d}
                    onPaste={handleBirthPaste}
                    onChange={(e) => handleBirth(i, e.target.value)}
                    onKeyDown={(e) => handleBirthKey(i, e)}
                    className={`size-[clamp(2.4rem,11vw,3rem)] rounded-xl border-2 bg-background text-center text-2xl font-extrabold text-foreground outline-none transition
                      ${d ? "border-primary shadow-md" : "border-border"}
                      focus:border-primary focus:shadow-md`}
                    aria-label={`생년월일 ${i + 1}번째 자리`}
                  />
                  {birthGroupAfter.has(i) && (
                    <span className="text-lg font-bold text-muted-foreground/50">·</span>
                  )}
                </span>
              ))}
            </div>
            <p className="mb-4 text-center text-xs text-muted-foreground/60">
              연도 2자리 · 월 2자리 · 일 2자리 &nbsp;예) 1950.03.15 → <span className="font-mono font-semibold">50 03 15</span>
            </p>

            {/* 로그인 유지 */}
            <label className="mb-3 flex cursor-pointer items-center gap-3 rounded-2xl border-2 border-border bg-background px-4 py-3 transition active:scale-[0.98] has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5">
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
              onClick={() => void enter()}
              disabled={loading}
              className="mt-1 w-full rounded-2xl bg-primary py-4 text-lg font-extrabold text-primary-foreground shadow-md transition active:scale-[0.98] disabled:opacity-60"
            >
              {loading ? "확인 중…" : "입장하기 →"}
            </button>

            <button
              type="button"
              onClick={() => {
                setFlow("choice");
                setShortDigits(["", "", "", ""]);
                setBirthDigits(["", "", "", "", "", ""]);
                setError("");
              }}
              className="mt-3 w-full rounded-2xl py-2.5 text-sm font-semibold text-muted-foreground transition active:scale-[0.98]"
            >
              ← 뒤로 가기
            </button>
          </div>
        )}

        <p className="mt-8 text-center text-xs text-muted-foreground leading-relaxed">
          담당 사회복지사에게 문의해 주세요.<br />
          <span className="font-semibold">
            {staffContacts.map((s, i) => (
              <span key={i}>
                {i > 0 && " · "}
                {s.phone ? (
                  <a href={`tel:${s.phone}`} className="underline underline-offset-2">
                    {s.name} 선생님 {s.phone}
                  </a>
                ) : (
                  <>{s.name} 선생님</>
                )}
              </span>
            ))}
          </span>
        </p>

        <p className="mt-3 text-center text-xs text-muted-foreground/70">
          <Link to="/privacy" className="underline underline-offset-2 hover:text-muted-foreground">
            개인정보처리방침
          </Link>
        </p>
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
