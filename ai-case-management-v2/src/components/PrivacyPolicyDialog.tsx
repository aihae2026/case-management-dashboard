import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PrivacyPolicyContent } from "@/components/PrivacyPolicyContent";
import { ORG_NAME } from "@/lib/org-config";

/** 개인정보처리방침을 새 창 없이 앱 안 창에서 읽는다. */
export function PrivacyPolicyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl h-[90dvh] flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle>개인정보처리방침</DialogTitle>
          <DialogDescription>{ORG_NAME} · 통합 사례관리 대시보드 · 시행일 2026년 10월 7일 · 최종 수정 2026년 10월 22일</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto pr-2">
          <PrivacyPolicyContent hideTitle />
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
