import { useCallback, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { hideAiNoticeToday, isAiNoticeHiddenToday } from "@/lib/ai-notice";

function browserStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * AI 로 내용을 보내기 직전에 "이름·민감정보가 AI 로 전송된다"고 알리는 안내창.
 * 동의를 받는 창이 아니라 알림이다. '오늘은 그만 보기'를 켜고 [계속]을 누르면 그날 자정(한국시간)까지 다시 묻지 않는다.
 *
 * 사용: const { confirmAiSend, noticeDialog } = useAiSendNotice();
 *       if (!(await confirmAiSend())) return;   // AI 호출 전에
 *       … 화면 어딘가에 {noticeDialog}
 */
export function useAiSendNotice(): { confirmAiSend: () => Promise<boolean>; noticeDialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const [hideToday, setHideToday] = useState(false);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);
  const uidRef = useRef("anon");

  const confirmAiSend = useCallback(async (): Promise<boolean> => {
    if (resolverRef.current) return false; // 이미 안내창이 열려 있으면 중복 호출은 무시
    let uid = "anon";
    try {
      const { data } = await supabase.auth.getSession();
      uid = data.session?.user.id ?? "anon";
    } catch {
      /* 사용자를 알 수 없으면 공용 키로 처리 */
    }
    uidRef.current = uid;
    if (isAiNoticeHiddenToday(browserStore(), uid)) return true;
    setHideToday(false);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  function finish(ok: boolean) {
    if (ok && hideToday) hideAiNoticeToday(browserStore(), uidRef.current);
    setOpen(false);
    resolverRef.current?.(ok);
    resolverRef.current = null;
  }

  const noticeDialog = (
    <Dialog open={open} onOpenChange={(v) => { if (!v) finish(false); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>AI로 전송되는 내용 안내</DialogTitle>
          <DialogDescription>
            이름과 민감정보(건강·연락처·주소 등)가 AI(구글 Gemini)로 전송돼요. 꼭 필요한 경우가 아니라면 제외하고 다듬어 주세요.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <Checkbox checked={hideToday} onCheckedChange={(v) => setHideToday(v === true)} />
          오늘은 그만 보기
        </label>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => finish(false)}>
            돌아가서 수정
          </Button>
          <Button onClick={() => finish(true)}>계속 다듬기</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirmAiSend, noticeDialog };
}
