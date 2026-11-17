import { useRef, useState } from "react";
import { Camera, X, LogOut, Play, Square, Loader2 } from "lucide-react";
import {
  DEFAULT_COMPANION_NAME,
  DEFAULT_SPEECH_RATE,
  DEFAULT_VOICE,
  DEFAULT_VOLUME,
  SPEECH_RATES,
  VOICE_OPTIONS,
  VOLUME_LEVELS,
  fileToAvatarDataUrl,
  type CompanionProfile,
} from "@/lib/profile";
import companionAvatar from "@/assets/companion-avatar.png";
import { unlockAudio } from "@/lib/audio-unlock";
import { isIOS } from "@/lib/device";

export function ProfileSettings({
  profile,
  sessionId,
  onSave,
  onClose,
  onLogout,
}: {
  profile: CompanionProfile;
  sessionId?: string;
  onSave: (profile: CompanionProfile) => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [avatar, setAvatar] = useState<string | null>(profile.avatar);
  const phone = profile.phone;
  const seniorName = profile.seniorName;
  const [busy, setBusy] = useState(false);
  const [voiceName, setVoiceName] = useState(profile.voiceName || DEFAULT_VOICE);
  const [speechRate, setSpeechRate] = useState(profile.speechRate ?? DEFAULT_SPEECH_RATE);
  const [volume, setVolume] = useState(profile.volume ?? DEFAULT_VOLUME);
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "playing">("idle");
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const stopPreview = () => {
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;
    setPreviewState("idle");
  };

  const togglePreview = () => {
    if (previewState !== "idle") {
      stopPreview();
      return;
    }

    setPreviewState("loading");

    // gesture frame에서 Audio element 생성 → autoplay 허용
    const audio = new Audio();
    audio.volume = Math.max(0.1, volume);
    previewAudioRef.current = audio;
    // 아이폰 Safari는 소리를 기다린 뒤의 재생을 막으므로, 누른 순간 무음을 먼저 재생해 권한을 열어 둔다
    unlockAudio(audio);

    const controller = new AbortController();
    previewAbortRef.current = controller;

    fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "안녕하세요! 저 왔어요, 잘 지내셨어요?",
        voiceName,
        sessionId,
      }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "unknown" })) as { error?: string };
          throw new Error(body.error ?? `http_${res.status}`);
        }
        const blob = await res.blob();
        const el = previewAudioRef.current;
        if (!el) return;

        const blobUrl = URL.createObjectURL(blob);
        el.src = blobUrl;
        el.playbackRate = Math.max(0.5, Math.min(2.0, speechRate));
        el.onended = () => {
          URL.revokeObjectURL(blobUrl);
          setPreviewState("idle");
          previewAudioRef.current = null;
        };
        setPreviewState("playing");
        await el.play();
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name === "AbortError") return;
        setPreviewState("idle");
      });
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const url = await fileToAvatarDataUrl(file);
      setAvatar(url);
    } catch { /* ignore */ } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/40 p-4 sm:items-center sm:p-6">
      <div
        className="my-auto w-full max-w-md rounded-3xl bg-card p-6 shadow-2xl md:max-w-lg md:p-8"
        style={{ animation: "soft-pop 0.2s ease-out" }}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[1.2em] font-extrabold text-foreground">설정</h2>
          <button
            type="button"
            onClick={() => { stopPreview(); onClose(); }}
            aria-label="닫기"
            className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground active:scale-95"
          >
            <X className="size-6" aria-hidden />
          </button>
        </div>

        {/* Avatar */}
        <div className="mb-5 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="relative rounded-full active:scale-95"
          >
            <img
              src={avatar || companionAvatar}
              alt="말벗 도우미 사진"
              className="size-24 rounded-full bg-secondary object-cover ring-4 ring-secondary"
            />
            <span className="absolute bottom-0 right-0 flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md">
              <Camera className="size-4" aria-hidden />
            </span>
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="rounded-full border-2 border-border bg-background px-3 py-1.5 text-[0.8em] font-bold text-foreground active:scale-95"
            >
              📷 사진 바꾸기
            </button>
            {avatar && (
              <button
                type="button"
                onClick={() => setAvatar(null)}
                className="rounded-full border-2 border-border bg-background px-3 py-1.5 text-[0.8em] font-bold text-muted-foreground active:scale-95"
              >
                기본 사진
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => pickPhoto(e.target.files?.[0])}
          />
        </div>

        <label className="mb-1.5 block text-[0.9em] font-bold text-foreground">말벗 이름</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={DEFAULT_COMPANION_NAME}
          maxLength={12}
          className="mb-4 w-full rounded-2xl border-2 border-border bg-background px-4 py-2.5 text-[1em] font-semibold text-foreground outline-none focus:border-ring"
        />

        <label className="mb-1.5 block text-[0.9em] font-bold text-foreground">어르신 성함</label>
        <input
          type="text"
          value={seniorName}
          readOnly
          className="mb-4 w-full rounded-2xl border-2 border-border bg-muted px-4 py-2.5 text-[1em] font-semibold text-muted-foreground outline-none"
        />

        <label className="mb-1.5 block text-[0.9em] font-bold text-foreground">전화번호</label>
        <input
          type="tel"
          inputMode="tel"
          value={phone}
          readOnly
          className="mb-1.5 w-full rounded-2xl border-2 border-border bg-muted px-4 py-2.5 text-[1em] font-semibold text-muted-foreground outline-none"
        />
        <p className="mb-4 text-[0.8em] text-muted-foreground">
          성함과 전화번호는 복지관에 등록된 정보예요. 바꾸려면 담당 선생님께 말씀해 주세요.
        </p>

        {/* 목소리 선택 */}
        <div className="mb-4 rounded-2xl bg-secondary/60 p-3">
          <p className="mb-2.5 text-[0.95em] font-bold text-foreground">🎤 목소리 선택</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {VOICE_OPTIONS.map((v) => {
              const isSelected = voiceName === v.name;
              return (
                <div
                  key={v.name}
                  onClick={() => { stopPreview(); setVoiceName(v.name); }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && setVoiceName(v.name)}
                  className={`flex cursor-pointer flex-col items-center rounded-2xl border-2 px-2 py-2.5 text-center transition select-none ${
                    isSelected
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-foreground"
                  }`}
                >
                  <span className="text-2xl leading-none">{v.emoji}</span>
                  <span className="mt-1 text-[0.78em] font-extrabold">{v.label}</span>
                  <span className="text-[0.68em] text-muted-foreground">{v.desc}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 말하기 속도 */}
        <div className="mb-4 rounded-2xl bg-secondary/60 p-3">
          <p className="mb-2.5 text-[0.95em] font-bold text-foreground">⚡ 말하기 속도</p>
          <div className="flex gap-2">
            {SPEECH_RATES.map((r) => {
              const isSelected = speechRate === r.value;
              return (
                <div
                  key={r.value}
                  onClick={() => { stopPreview(); setSpeechRate(r.value); }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && setSpeechRate(r.value)}
                  className={`flex flex-1 cursor-pointer items-center justify-center rounded-2xl border-2 py-3 text-center transition select-none ${
                    isSelected
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-foreground"
                  }`}
                >
                  <span className="text-[0.9em] font-extrabold">{r.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 음량 — 아이폰·아이패드는 웹에서 음량을 바꿀 수 없어서 안내만 보여준다 */}
        {isIOS() ? (
          <div className="mb-4 rounded-2xl bg-secondary/60 p-3">
            <p className="mb-1.5 text-[0.95em] font-bold text-foreground">🔊 음량</p>
            <p className="text-[0.85em] leading-relaxed text-muted-foreground">
              아이폰·아이패드는 기기 옆의 음량 버튼으로 소리를 조절해 주세요.
            </p>
          </div>
        ) : (
        <div className="mb-4 rounded-2xl bg-secondary/60 p-3">
          <p className="mb-2.5 text-[0.95em] font-bold text-foreground">🔊 음량</p>
          <div className="flex gap-2">
            {VOLUME_LEVELS.map((v) => {
              const isSelected = volume === v.value;
              return (
                <button
                  key={v.value}
                  type="button"
                  onClick={() => setVolume(v.value)}
                  className={`flex flex-1 cursor-pointer flex-col items-center gap-1 rounded-2xl border-2 py-2.5 text-center transition select-none active:scale-95 ${
                    isSelected
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-foreground"
                  }`}
                >
                  <span className="text-[1.3em]">{v.emoji}</span>
                  <span className="text-[0.85em] font-extrabold">{v.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        )}

        {/* 미리듣기 */}
        <button
          type="button"
          onClick={togglePreview}
          disabled={previewState === "loading"}
          className={`mb-3 flex w-full items-center justify-center gap-2 rounded-2xl border-2 px-6 py-3 text-[0.95em] font-extrabold transition active:scale-[0.98] ${
            previewState === "playing"
              ? "border-primary bg-primary/10 text-primary"
              : "border-border bg-background text-foreground"
          }`}
        >
          {previewState === "loading" && <Loader2 className="size-[1.1em] animate-spin" aria-hidden />}
          {previewState === "playing" && <Square className="size-[1.1em] fill-current" aria-hidden />}
          {previewState === "idle" && <Play className="size-[1.1em] fill-current" aria-hidden />}
          {previewState === "loading" ? "불러오는 중..." : previewState === "playing" ? "정지" : "미리듣기"}
        </button>

        <button
          type="button"
          onClick={() => {
            stopPreview();
            onSave({
              ...profile,
              name: name.trim() || DEFAULT_COMPANION_NAME,
              avatar,
              phone: phone.trim(),
              seniorName: seniorName.trim(),
              voiceName,
              speechRate,
              volume,
            });
          }}
          className="w-full rounded-2xl bg-primary px-6 py-4 text-[1.05em] font-extrabold text-primary-foreground active:scale-[0.98]"
        >
          저장하기
        </button>

        <button
          type="button"
          onClick={onLogout}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-destructive/40 bg-background px-6 py-3 text-[0.95em] font-extrabold text-destructive active:scale-[0.98]"
        >
          <LogOut className="size-[1.1em]" aria-hidden />
          로그아웃
        </button>
      </div>
    </div>
  );
}
