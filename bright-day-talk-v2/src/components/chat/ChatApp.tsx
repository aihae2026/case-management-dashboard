import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { getHistory, type StoredMessage } from "@/lib/chat.functions";
import { getSessionId, overrideSessionId } from "@/lib/session";
import { LINK_KEY, REG_ID_KEY } from "@/lib/device-link";
import { clearBirthVerified } from "@/lib/birth-auth";
import { DEFAULT_SPEECH_RATE, DEFAULT_VOICE, DEFAULT_VOLUME, loadProfile, saveProfile, type CompanionProfile } from "@/lib/profile";
import { saveSeniorPhone, syncCareContext, getShortCode, getStaffContact } from "@/lib/senior.functions";
import { getMyRegistration, getRegistrationStatus } from "@/lib/registration.functions";
import { ChatWindow } from "./ChatWindow";
import { ProfileSettings } from "./ProfileSettings";
import { WorkerSetupFlow } from "./WorkerSetupFlow";
import { PendingApproval } from "./PendingApproval";
import companionAvatar from "@/assets/companion-avatar.png";

const FONT_STEPS = [19, 23, 28];
const FONT_KEY = "malbeot_font_level";
// 승인 해제를 확인하는 간격. 해제가 최대 이만큼 늦게 반영된다.
const REVOKE_CHECK_MS = 45_000;

type RegInfo = {
  id: string;
  orgCode: string;
  orgName: string;
  seniorName: string;
  seniorPhone: string;
};

type Phase = "loading" | "setup" | "pending" | "rejected" | "ready" | "error";

export function ChatApp() {
  const navigate = useNavigate();
  const [fontLevel, setFontLevel] = useState(1);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [history, setHistory] = useState<StoredMessage[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [profile, setProfile] = useState<CompanionProfile>({
    name: "복순이",
    avatar: null,
    phone: "",
    seniorName: "",
    orgCode: "",
    voiceName: DEFAULT_VOICE,       // (I-H2) 초기값 누락 방지
    speechRate: DEFAULT_SPEECH_RATE,
    volume: DEFAULT_VOLUME,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [regInfo, setRegInfo] = useState<RegInfo | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string | null>(null);
  const [staffPhone, setStaffPhone] = useState<string | null>(null);
  const [staffName, setStaffName] = useState<string | null>(null);

  // 폰트 크기 복원
  useEffect(() => {
    const saved = Number(window.localStorage.getItem(FONT_KEY));
    if (saved >= 0 && saved <= 2) setFontLevel(saved);
  }, []);

  // 복지관 담당자 목록(번호 폴백용). 한 번만 불러온다.
  const [staffDirectory, setStaffDirectory] = useState<{ name: string; phone: string }[]>([]);
  useEffect(() => {
    fetch("/api/staff-contacts")
      .then((r) => r.json() as Promise<{ name: string; phone: string }[]>)
      .then((list) => { if (Array.isArray(list)) setStaffDirectory(list); })
      .catch(() => {});
  }, []);

  // 화면에 보여 줄 담당자 연락처.
  // 1) DB에 번호가 있으면 그 번호와 이름, 2) 없으면 이름이 같은 목록의 번호,
  // 3) 그것도 없으면 복지관 대표(목록 첫 항목) 번호. 3)일 때는 다른 사람 이름이 붙지 않도록 이름을 보여 주지 않는다.
  const staffFromDirectory = staffDirectory.find((s) => s.name === staffName)?.phone ?? null;
  const shownStaffPhone = staffPhone ?? staffFromDirectory ?? staffDirectory[0]?.phone ?? null;
  const shownStaffName = staffPhone || staffFromDirectory ? staffName : null;

  // ── 앱 초기화 ─────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
    let id = getSessionId();
    const loaded = loadProfile();
    setProfile(loaded);

    const linked = window.localStorage.getItem(LINK_KEY) === "1";
    const savedRegId = window.localStorage.getItem(REG_ID_KEY);

    // 관리자가 승인하는 순간 서버가 이 기기의 등록을 기존 어르신 세션으로 옮겨 둘 수 있다.
    // 등록 id로 현재 세션을 먼저 확인해서, 달라졌으면 따라간다 (대화 기록이 이어진다).
    // 이미 활성화된 기기는 세션이 그대로라서 건너뛴다.
    if (savedRegId && !linked) {
      try {
        const st = await getRegistrationStatus({ data: { registrationId: savedRegId } });
        if (st.status === "approved" && st.sessionId && st.sessionId !== id) {
          overrideSessionId(st.sessionId);
          id = st.sessionId;
        }
      } catch { /* 네트워크 오류면 지금 세션으로 진행 */ }
    }
    if (cancelled) return;
    setSessionId(id);

    if (linked && savedRegId) {
      // 채팅 열기 전에 승인 상태를 먼저 확인한다 (승인 해제/삭제 즉시 차단).
      // 네트워크 오류 시에만 예외적으로 채팅을 열어 줌 (어르신 UX 우선).
      getMyRegistration({ data: { sessionId: id } })
        .then(({ registration }) => {
          if (!registration || registration.status !== "approved") {
            forceReset();
            return;
          }
          // 이 세션의 승인 등록이 다른 등록으로 바뀌었으면(재승인 때 옛 등록이 정리됨) 새 등록 id를 기억한다
          if (registration.id !== savedRegId) {
            try { window.localStorage.setItem(REG_ID_KEY, registration.id as string); } catch { /* ignore */ }
          }
          // 승인 유효 → 기록·케어·담당자 연락처 병렬 로드
          getHistory({ data: { sessionId: id } })
            .then((rows) => { setHistory(rows); setPhase("ready"); })
            .catch(() => setPhase("ready"));
          syncCareContext({ data: { sessionId: id } }).catch(() => {});
          getStaffContact({ data: { sessionId: id } })
            .then(({ staffPhone: sp, staffName: sn }) => { if (sp) setStaffPhone(sp); if (sn) setStaffName(sn); })
            .catch(() => {});
        })
        .catch(() => {
          // 서버 오류 시 채팅은 열되 케어만 갱신 (네트워크 불안정 대비)
          getHistory({ data: { sessionId: id } })
            .then((rows) => { setHistory(rows); setPhase("ready"); })
            .catch(() => setPhase("ready"));
          syncCareContext({ data: { sessionId: id } }).catch(() => {});
          getStaffContact({ data: { sessionId: id } })
            .then(({ staffPhone: sp, staffName: sn }) => { if (sp) setStaffPhone(sp); if (sn) setStaffName(sn); })
            .catch(() => {});
        });
      return;
    }

    // 미활성화: 등록 기록 확인
    getMyRegistration({ data: { sessionId: id } })
      .then(({ registration }) => {
        if (!registration) { setPhase("setup"); return; }
        const info: RegInfo = {
          id: registration.id as string,
          orgCode: registration.org_code as string,
          orgName: (registration.org_name as string) ?? (registration.org_code as string),
          seniorName: registration.senior_name as string,
          seniorPhone: registration.senior_phone as string,
        };
        setRegInfo(info);

        if (registration.status === "approved") {
          activateDevice(info, id);
        } else if (registration.status === "rejected") {
          setRejectionReason((registration.rejection_reason as string | null) ?? null);
          setPhase("rejected");
        } else {
          setPhase("pending");
        }
      })
      .catch(() => setPhase("setup"));
    };
    void boot();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── ready 상태: 승인 해제·삭제 감지 ──
  // 서버 함수로 주기적으로 확인한다(브라우저가 DB를 직접 구독하려면 anon이 등록 테이블을 읽을 수 있어야 해서 서버 경유로 바꿨다).
  // 확인은 앱을 열어 둔 동안 REVOKE_CHECK_MS마다, 그리고 화면이 다시 보일 때 한 번 한다.
  useEffect(() => {
    if (phase !== "ready") return;

    let regId = window.localStorage.getItem(REG_ID_KEY);
    if (!regId) return;

    let stopped = false;
    const check = async () => {
      if (stopped || !regId) return;
      try {
        const { status } = await getRegistrationStatus({ data: { registrationId: regId } });
        if (stopped || status === "approved") return;
        if (status === null) {
          // 등록이 없어졌다. 같은 어르신이 새 기기에서 재승인되면 옛 등록은 정리되고 이 세션은 새 등록으로 이어지므로,
          // 이 세션에 승인된 등록이 남아 있는지 보고, 있으면 그 등록을 기준으로 계속 쓴다.
          const { registration } = await getMyRegistration({ data: { sessionId: getSessionId() } });
          if (stopped) return;
          if (registration?.status === "approved") {
            regId = registration.id as string;
            try { window.localStorage.setItem(REG_ID_KEY, regId); } catch { /* ignore */ }
            return;
          }
        }
        // 승인이 아니거나(해제·거절) 등록이 정말 없으면 처음 화면으로 돌려보낸다. 오류일 때는 아무것도 하지 않는다.
        forceReset();
      } catch { /* 네트워크·서버 오류는 다음 확인 때 다시 본다 */ }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };

    const timer = setInterval(() => void check(), REVOKE_CHECK_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // 강제 초기화 (승인 해제/삭제 시) → 랜딩 페이지로 이동
  const forceReset = () => {
    window.localStorage.removeItem(LINK_KEY);
    window.localStorage.removeItem(REG_ID_KEY);
    // URL에서 short_code를 추출해 생년월일 캐시도 함께 제거
    const code = window.location.pathname.replace(/^\//, "").replace(/\D/g, "").slice(0, 4);
    if (code) clearBirthVerified(code);
    void navigate({ to: "/" });
  };

  // 등록 완료 후 대기 화면으로
  const handleRegistered = (registrationId: string) => {
    try { window.localStorage.setItem(REG_ID_KEY, registrationId); } catch { /* ignore */ }
    const id = sessionId ?? getSessionId();
    getMyRegistration({ data: { sessionId: id } })
      .then(({ registration }) => {
        if (!registration) return;
        setRegInfo({
          id: registration.id as string,
          orgCode: registration.org_code as string,
          orgName: (registration.org_name as string) ?? (registration.org_code as string),
          seniorName: registration.senior_name as string,
          seniorPhone: registration.senior_phone as string,
        });
        setPhase("pending");
      })
      .catch(() => setPhase("pending"));
  };

  // 승인 완료 시 디바이스 활성화
  // 다른 기기에서 재승인하는 경우의 세션 이어받기는 승인할 때 서버가 처리한다(registration.functions.ts의 approveRegistration).
  // 여기로 넘어오는 sid는 이미 서버가 정한 이 등록의 세션이다.
  const activateDevice = async (info: RegInfo, sid: string) => {
    const next: CompanionProfile = {
      ...loadProfile(),
      orgCode: info.orgCode,
      seniorName: info.seniorName,
      phone: info.seniorPhone,
    };
    saveProfile(next);
    setProfile(next);
    window.localStorage.setItem(LINK_KEY, "1");
    window.localStorage.setItem(REG_ID_KEY, info.id);
    setRegInfo(info);

    const canonicalSid = sid;

    if (canonicalSid) {
      // org_code까지 저장한 뒤 즉시 care context 동기화 (첫 활성화 시 케어 기록 바로 연결)
      saveSeniorPhone({ data: { sessionId: canonicalSid } })
        .then(() => syncCareContext({ data: { sessionId: canonicalSid } }))
        .catch((err) => console.error("[care-link] activation sync failed:", err));
    }

    getHistory({ data: { sessionId: canonicalSid } })
      .then((rows) => { setHistory(rows); setPhase("ready"); })
      .catch(() => setPhase("ready"));
    getStaffContact({ data: { sessionId: canonicalSid } })
      .then(({ staffPhone: sp, staffName: sn }) => { if (sp) setStaffPhone(sp); if (sn) setStaffName(sn); })
      .catch(() => {});

    // 승인 완료 후 URL을 /{code} 형태로 업데이트 (북마크용)
    getShortCode({ data: { sessionId: canonicalSid } })
      .then(({ shortCode }) => {
        if (shortCode && typeof window !== "undefined") {
          const target = `/${shortCode}`;
          if (window.location.pathname !== target) {
            window.history.replaceState(null, "", target);
          }
        }
      })
      .catch(() => {/* URL 업데이트 실패는 무시 */});
  };

  const handleApproved = (approvedSessionId?: string) => {
    // 서버가 승인하면서 이 기기의 등록을 기존 어르신 세션으로 옮겼으면 그 세션으로 바꾼다
    const sid = approvedSessionId ?? sessionId;
    if (approvedSessionId && approvedSessionId !== sessionId) {
      overrideSessionId(approvedSessionId);
      setSessionId(approvedSessionId);
    }
    if (regInfo && sid) activateDevice(regInfo, sid);
  };

  const handleReset = () => {
    window.localStorage.removeItem(LINK_KEY);
    window.localStorage.removeItem(REG_ID_KEY);
    const code = window.location.pathname.replace(/^\//, "").replace(/\D/g, "").slice(0, 4);
    if (code) clearBirthVerified(code);
    void navigate({ to: "/" });
  };

  // 거절 콜백 (PendingApproval → ChatApp) (U-1)
  const handleRejected = (reason?: string) => {
    setRejectionReason(reason ?? null);
    setPhase("rejected");
  };

  const changeFont = (level: number) => {
    setFontLevel(level);
    window.localStorage.setItem(FONT_KEY, String(level));
  };

  // 성함·전화번호는 승인된 등록 정보가 기준이라 설정 화면에서 바꿔도 서버에는 보내지 않는다.
  const handleSaveProfile = (next: CompanionProfile) => {
    saveProfile(next);
    setProfile(next);
    setSettingsOpen(false);
  };

  // ── 화면 분기 ─────────────────────────────────────

  if (phase === "loading") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background lg:bg-gradient-to-br lg:from-brand/20 lg:via-background lg:to-brand/10">
        <p className="text-lg font-bold text-muted-foreground">잠시만 기다려 주세요…</p>
      </div>
    );
  }

  if (phase === "setup" && sessionId) {
    return (
      <div style={{ fontSize: `${FONT_STEPS[fontLevel]}px` }}>
        <WorkerSetupFlow sessionId={sessionId} onRegistered={handleRegistered} />
      </div>
    );
  }

  if (phase === "pending" && regInfo) {
    return (
      <div style={{ fontSize: `${FONT_STEPS[fontLevel]}px` }}>
        <PendingApproval
          registrationId={regInfo.id}
          orgName={regInfo.orgName || regInfo.orgCode}
          seniorName={regInfo.seniorName}
          sessionId={sessionId ?? ""}
          onApproved={handleApproved}
          onRejected={handleRejected}
          onLogout={handleReset}
        />
      </div>
    );
  }

  if (phase === "rejected") {
    return (
      <div style={{ fontSize: `${FONT_STEPS[fontLevel]}px` }}>
      <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-6 py-8 text-center">
        <div className="mb-4 text-5xl">🚫</div>
        <h1 className="text-2xl font-extrabold text-foreground">등록이 거절되었어요</h1>
        {rejectionReason && (
          <p className="mt-2 rounded-xl bg-muted px-4 py-2 text-sm text-muted-foreground">
            {rejectionReason}
          </p>
        )}
        <p className="mt-4 text-sm text-muted-foreground">담당 관리자에게 문의해 주세요.</p>
        <button
          type="button"
          onClick={handleReset}
          className="mt-8 rounded-xl border-2 border-border bg-background px-5 py-2.5 text-sm font-semibold text-muted-foreground"
        >
          다시 시도하기
        </button>
      </div>
      </div>
    );
  }

  // ── Ready: 채팅 화면 ──────────────────────────────────
  const avatarSrc = profile.avatar || companionAvatar;

  return (
    /* 데스크톱: 브랜드 배경 위에 채팅 패널 중앙 배치 */
    <div className="flex min-h-[100dvh] items-stretch justify-center bg-background lg:items-center lg:bg-gradient-to-br lg:from-brand/20 lg:via-background lg:to-brand/10 lg:p-6">
    <div
      className="flex h-[100dvh] w-full flex-col bg-background md:max-w-[680px] md:border-x md:border-border lg:h-[min(96dvh,900px)] lg:overflow-hidden lg:rounded-3xl lg:border-x-0 lg:shadow-2xl"
      style={{ fontSize: `${FONT_STEPS[fontLevel]}px` }}
    >
      {/* Header */}
      <header className="shrink-0 border-b-2 border-border bg-brand px-3 py-2 text-brand-foreground lg:px-5 lg:py-3">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-2 lg:max-w-none">
          <img
            src={avatarSrc}
            alt=""
            className="size-10 shrink-0 rounded-full bg-secondary object-cover ring-2 ring-white/40 max-[359px]:hidden"
            style={{ animation: "avatar-bob 3.2s ease-in-out infinite" }}
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[1em] font-extrabold leading-tight">{profile.name}</h1>
            {profile.seniorName && (
              <p className="truncate text-[0.8em] font-medium text-brand-foreground/90">
                {profile.seniorName.replace(/\d{1,2}$/, "").trim()} 어르신
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-end gap-1" role="group" aria-label="글씨 크기 조절">
            {[
              { label: "작게", size: "text-sm" },
              { label: "보통", size: "text-base" },
              { label: "크게", size: "text-xl" },
            ].map((opt, i) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => changeFont(i)}
                aria-pressed={fontLevel === i}
                className={`flex min-h-11 min-w-11 flex-col items-center justify-center rounded-lg px-2 py-1 font-bold leading-none transition ${
                  fontLevel === i
                    ? "bg-white text-brand"
                    : "bg-white/15 text-brand-foreground active:scale-95"
                }`}
              >
                <span className={opt.size}>가</span>
                <span className="mt-0.5 text-[0.7rem] font-semibold">{opt.label}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="설정"
            className="flex min-h-11 min-w-11 shrink-0 flex-col items-center justify-center rounded-lg bg-white/15 px-2 py-1 font-bold leading-none text-brand-foreground active:scale-95"
          >
            <Settings className="size-5" aria-hidden />
            <span className="mt-0.5 text-[0.7rem] font-semibold">설정</span>
          </button>
        </div>
      </header>

      {phase === "ready" && sessionId ? (
        <ChatWindow
          key={sessionId}
          sessionId={sessionId}
          initialHistory={history}
          companionName={profile.name}
          seniorName={profile.seniorName}
          avatarSrc={avatarSrc}
          voiceName={profile.voiceName}
          speechRate={profile.speechRate}
          volume={profile.volume}
          staffPhone={shownStaffPhone ?? undefined}
          staffName={shownStaffName ?? undefined}
          onRevoked={forceReset}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <img src={avatarSrc} alt="" className="size-20 rounded-full bg-secondary object-cover" />
          <p className="text-[1.05em] font-bold text-muted-foreground">잠시만 기다려 주세요…</p>
        </div>
      )}

      {settingsOpen && (
        <ProfileSettings
          profile={profile}
          sessionId={sessionId ?? undefined}
          onSave={handleSaveProfile}
          onClose={() => setSettingsOpen(false)}
          onLogout={handleReset}
        />
      )}
    </div>
    </div>
  );
}
