import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NameMaskContext, maskedName, useNameMask } from "@/lib/name-mask-context";

const KEY = "hideClientNames";

/** 이름 숨기기 상태 공급자. 브라우저 세션 동안만 기억한다(새로 열면 이름이 보이는 기본 상태). */
export function NameMaskProvider({ children }: { children: ReactNode }) {
  const [hidden, setHiddenState] = useState(false);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(KEY) === "1") setHiddenState(true);
    } catch { /* 저장소 사용 불가 시 기본값 유지 */ }
  }, []);

  const value = useMemo(
    () => ({
      hidden,
      setHidden: (v: boolean) => {
        setHiddenState(v);
        try { window.sessionStorage.setItem(KEY, v ? "1" : "0"); } catch { /* ignore */ }
      },
    }),
    [hidden],
  );
  return <NameMaskContext.Provider value={value}>{children}</NameMaskContext.Provider>;
}

/** 대상자 이름 표시. 숨기기가 켜져 있으면 대상자 번호를 보여 준다. */
export function ClientName({
  c,
  fallback = "",
}: {
  c: { name?: string | null; client_code?: string | null } | null | undefined;
  fallback?: string;
}) {
  const { hidden } = useNameMask();
  return <>{maskedName(c, hidden, fallback)}</>;
}

/** 상단 바의 이름 숨기기 켜고 끄기 버튼 */
export function NameMaskToggle() {
  const { hidden, setHidden } = useNameMask();
  return (
    <Button
      size="sm"
      className="px-2 sm:px-3"
      variant={hidden ? "secondary" : "ghost"}
      onClick={() => setHidden(!hidden)}
      title={
        hidden
          ? "이름을 다시 보여요. (화면에서만 바뀌고 데이터는 그대로예요)"
          : "화면에서 대상자 이름 대신 번호를 보여요. 회의·화면 공유·시연 때 쓰세요. 상담 내용 속 이름은 가려지지 않아요."
      }
      aria-pressed={hidden}
    >
      {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      <span className="hidden sm:inline">{hidden ? "이름 숨김 중" : "이름 숨기기"}</span>
    </Button>
  );
}
