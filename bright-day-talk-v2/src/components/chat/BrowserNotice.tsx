import { useEffect, useState } from "react";
import { isInAppBrowser, isOutdatedBrowser } from "@/lib/device";

const CLOSED_KEY = "malbeot_browser_notice_closed";

// 카카오톡 같은 앱 안에서 열었거나 브라우저가 너무 오래된 경우에만 보이는 안내.
// 서버 화면과 어긋나지 않도록 브라우저에서 확인한 뒤에 보여준다.
export function BrowserNotice() {
  const [kind, setKind] = useState<"inapp" | "old" | null>(null);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(CLOSED_KEY) === "1") return;
    } catch {
      /* 저장소를 못 써도 안내는 보여준다 */
    }
    if (isInAppBrowser()) setKind("inapp");
    else if (isOutdatedBrowser()) setKind("old");
  }, []);

  if (!kind) return null;

  const close = () => {
    try {
      sessionStorage.setItem(CLOSED_KEY, "1");
    } catch {
      /* ignore */
    }
    setKind(null);
  };

  return (
    <div
      role="note"
      className="mb-5 w-full rounded-2xl bg-amber-100 px-4 py-3 text-[0.9rem] leading-relaxed text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
    >
      <p className="font-semibold">
        {kind === "inapp"
          ? "카카오톡 같은 앱 안에서 열면 말로 입력하는 기능이 안 될 수 있어요. 오른쪽 위 메뉴에서 '다른 브라우저로 열기'를 눌러 크롬이나 사파리로 열어 주세요."
          : "이 휴대폰의 인터넷 앱이 오래되어 화면이 다르게 보일 수 있어요. 휴대폰 설정에서 업데이트하거나, 최신 크롬·사파리로 열어 주세요."}
      </p>
      <button
        type="button"
        onClick={close}
        className="mt-2 min-h-11 rounded-full bg-amber-200 px-5 text-[0.9rem] font-bold text-amber-900 active:scale-95 dark:bg-amber-800/50 dark:text-amber-100"
      >
        알겠어요
      </button>
    </div>
  );
}
