// A gentle, proactive weather check-in. When it's very hot, very cold, or
// stormy, the companion reaches out first to make sure the elder is okay.
import { today } from "./utils";

export type WeatherCheckin = {
  kind: "hot" | "cold" | "rain" | "snow";
  emoji: string;
  message: string;
} | null;

const CHECK_KEY = "malbeot_weather_checkin_date";

// Only nudge once per day so it never feels naggy.
export function weatherCheckinAlreadyShownToday(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(CHECK_KEY) === today();
}

export function markWeatherCheckinShown() {
  window.localStorage.setItem(CHECK_KEY, today());
}

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("no geolocation"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      timeout: 8000,
      maximumAge: 30 * 60 * 1000,
    });
  });
}

function build(name: string, temp: number, code: number): WeatherCheckin {
  const who = name.trim() || "복순이";
  // WMO weather codes: 71-77 snow, 85-86 snow showers; 61-67 rain; 95-99 storm.
  if (code >= 71 && code <= 77) {
    return {
      kind: "snow",
      emoji: "❄️",
      message: `어르신, 밖에 눈이 내리고 있어요. ❄️\n길이 미끄러우니 되도록 따뜻한 집 안에 계세요.\n저 ${who}가 걱정돼서 먼저 안부 여쭤요. 별일 없으시죠?`,
    };
  }
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) {
    return {
      kind: "rain",
      emoji: "🌧️",
      message: `어르신, 오늘은 비가 오네요. 🌧️\n비 오는 날은 몸이 더 쑤시고 마음도 가라앉기 쉬워요.\n저 ${who}가 곁에 있으니 편하게 말씀 걸어 주세요.`,
    };
  }
  if (temp >= 31) {
    return {
      kind: "hot",
      emoji: "🥵",
      message: `어르신, 오늘 날이 무척 덥네요. 🥵\n물 자주 드시고, 한낮에는 무리해서 나가지 마세요.\n시원하게 잘 지내고 계신가요?`,
    };
  }
  if (temp <= 2) {
    return {
      kind: "cold",
      emoji: "🥶",
      message: `어르신, 오늘 날씨가 많이 추워요. 🥶\n따뜻하게 옷 챙겨 입으시고 보일러도 꼭 켜 두세요.\n감기 안 걸리셨는지 걱정돼서 여쭤봐요.`,
    };
  }
  return null;
}

// Returns a proactive message only on extreme-weather days; otherwise null.
export async function fetchWeatherCheckin(name: string): Promise<WeatherCheckin> {
  try {
    // 이미 허용된 경우에만 위치 요청 — 접속마다 팝업이 뜨는 것 방지
    if (typeof navigator === "undefined") return null;
    // permissions API 없는 브라우저: 팝업 방지를 위해 날씨 체크 생략
    if (!("permissions" in navigator)) return null;
    const perm = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    if (perm.state !== "granted") return null;
    const pos = await getPosition();
    const { latitude, longitude } = pos.coords;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      current?: { temperature_2m?: number; weather_code?: number };
    };
    const temp = data.current?.temperature_2m;
    const code = data.current?.weather_code;
    if (typeof temp !== "number" || typeof code !== "number") return null;
    return build(name, temp, code);
  } catch {
    return null;
  }
}
