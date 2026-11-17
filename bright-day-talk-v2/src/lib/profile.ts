// Client-side companion profile: a customizable name and photo for the chatbot,
// the elder's name/phone (used to link with the case-management system),
// and the organization access code.
export type CompanionProfile = {
  name: string; // 말벗(도우미) 이름
  avatar: string | null;
  phone: string;
  seniorName: string; // 어르신 이름
  orgCode: string;
  voiceName: string;  // Gemini TTS 목소리 이름 (e.g. "Kore", "Puck")
  speechRate: number; // 말하기 속도 (0.7 ~ 1.4)
  volume: number;     // 음량 (0.0 ~ 1.0)
};

// 선택 가능한 TTS 목소리 목록 (손자손녀 느낌 위주)
export const VOICE_OPTIONS = [
  { name: "Puck",   emoji: "😄", label: "활발한 목소리",   desc: "손자 느낌" },
  { name: "Aoede",  emoji: "🌸", label: "부드러운 목소리", desc: "손녀 느낌" },
  { name: "Kore",   emoji: "☀️", label: "따뜻한 목소리",   desc: "기본값" },
  { name: "Leda",   emoji: "✨", label: "맑은 목소리",     desc: "젊고 맑은" },
  { name: "Zephyr", emoji: "🎵", label: "경쾌한 목소리",   desc: "밝고 경쾌한" },
] as const;

export const SPEECH_RATES = [
  { value: 0.8,  label: "천천히" },
  { value: 1.0,  label: "보통" },
  { value: 1.25, label: "빠르게" },
] as const;

export const DEFAULT_VOICE = "Puck";
export const DEFAULT_SPEECH_RATE = 1.0;
export const DEFAULT_VOLUME = 1.0;

export const VOLUME_LEVELS = [
  { value: 0.5,  label: "작게",  emoji: "🔉" },
  { value: 0.75, label: "보통",  emoji: "🔊" },
  { value: 1.0,  label: "크게",  emoji: "📢" },
] as const;

const NAME_KEY = "malbeot_companion_name";
const AVATAR_KEY = "malbeot_companion_avatar";
const PHONE_KEY = "malbeot_senior_phone";
const SENIOR_NAME_KEY = "malbeot_senior_name";
const ORG_KEY = "malbeot_org_code";
const VOICE_KEY = "malbeot_voice_name";
const RATE_KEY = "malbeot_speech_rate";
const VOLUME_KEY = "malbeot_volume";

export const DEFAULT_COMPANION_NAME = "복순이";

export function loadProfile(): CompanionProfile {
  if (typeof window === "undefined") {
    return {
      name: DEFAULT_COMPANION_NAME,
      avatar: null,
      phone: "",
      seniorName: "",
      orgCode: "",
      voiceName: DEFAULT_VOICE,
      speechRate: DEFAULT_SPEECH_RATE,
      volume: DEFAULT_VOLUME,
    };
  }
  const rawRate = parseFloat(window.localStorage.getItem(RATE_KEY) ?? "");
  const rawVol = parseFloat(window.localStorage.getItem(VOLUME_KEY) ?? "");
  return {
    name: window.localStorage.getItem(NAME_KEY) || DEFAULT_COMPANION_NAME,
    avatar: window.localStorage.getItem(AVATAR_KEY),
    phone: window.localStorage.getItem(PHONE_KEY) || "",
    seniorName: window.localStorage.getItem(SENIOR_NAME_KEY) || "",
    orgCode: window.localStorage.getItem(ORG_KEY) || "",
    voiceName: window.localStorage.getItem(VOICE_KEY) || DEFAULT_VOICE,
    speechRate: isNaN(rawRate) ? DEFAULT_SPEECH_RATE : rawRate,
    volume: isNaN(rawVol) ? DEFAULT_VOLUME : Math.min(1, Math.max(0, rawVol)),
  };
}

export function saveProfile(profile: CompanionProfile) {
  const name = profile.name.trim() || DEFAULT_COMPANION_NAME;
  window.localStorage.setItem(NAME_KEY, name);

  // avatar는 data URL이라 크기가 커서 QuotaExceededError 가능 — 별도 try-catch (U-6)
  try {
    if (profile.avatar) {
      window.localStorage.setItem(AVATAR_KEY, profile.avatar);
    } else {
      window.localStorage.removeItem(AVATAR_KEY);
    }
  } catch {
    // 저장 공간 부족 시 아바타만 포기하고 나머지는 계속 저장
    window.localStorage.removeItem(AVATAR_KEY);
  }

  const phone = profile.phone.trim();
  if (phone) window.localStorage.setItem(PHONE_KEY, phone);
  else window.localStorage.removeItem(PHONE_KEY);

  const seniorName = profile.seniorName.trim();
  if (seniorName) window.localStorage.setItem(SENIOR_NAME_KEY, seniorName);
  else window.localStorage.removeItem(SENIOR_NAME_KEY);

  const org = profile.orgCode.trim().toUpperCase();
  if (org) window.localStorage.setItem(ORG_KEY, org);
  else window.localStorage.removeItem(ORG_KEY);

  if (profile.voiceName) window.localStorage.setItem(VOICE_KEY, profile.voiceName);
  window.localStorage.setItem(RATE_KEY, String(profile.speechRate ?? DEFAULT_SPEECH_RATE));
  window.localStorage.setItem(VOLUME_KEY, String(profile.volume ?? DEFAULT_VOLUME));
}

// Read an image file, shrink it to a small square, and return a compact data URL
// so it fits comfortably in localStorage.
export function fileToAvatarDataUrl(file: File, size = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("no canvas context"));
          return;
        }
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => reject(new Error("image load failed"));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}
