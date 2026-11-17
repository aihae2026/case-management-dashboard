import { useState } from "react";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Client } from "@/lib/case-types";

// 담당자 이름 변경(오타 정정용). 기관 멤버 화면에서 관리자가 연다.
export function WorkerManageDialog({
  open,
  onOpenChange,
  workers,
  clients,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workers: string[];
  clients: Client[];
  onChanged: () => void;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const countOf = (name: string) => clients.filter((c) => (c.worker_name ?? "") === name).length;

  async function rename(oldName: string) {
    const newName = (edits[oldName] ?? oldName).trim();
    if (!newName || newName === oldName) return;
    if (workers.includes(newName)) {
      if (!confirm(`'${newName}' 담당자가 이미 있습니다. 두 담당자의 대상자를 합칠까요?`)) return;
    }
    setBusy(oldName);
    try {
      const r1 = await supabase
        .from("clients")
        .update({ worker_name: newName })
        .eq("worker_name", oldName);
      if (r1.error) throw r1.error;
      // 상담기록의 담당자명도 함께 정리
      await supabase
        .from("activity_logs")
        .update({ worker_name: newName })
        .eq("worker_name", oldName);
      toast.success(
        `'${oldName}' → '${newName}' 로 변경되었습니다. (대상자 ${countOf(oldName)}명 반영)`,
      );
      setEdits((e) => {
        const n = { ...e };
        delete n[oldName];
        return n;
      });
      onChanged();
    } catch (e) {
      toast.error("변경 실패: " + (e as Error).message);
    }
    setBusy(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>담당자 관리</DialogTitle>
          <DialogDescription>
            담당자 이름을 바꾸면 해당 담당자의 모든 대상자·상담기록에 한 번에 반영됩니다. 새
            담당자는 대상자 등록 시 [담당자]에서 직접 입력하면 목록에 추가됩니다. 이름 오타를 고칠 때 쓰세요.
            담당을 다른 사람에게 넘기는 거라면 상담기록의 작성자 이름까지 바뀌니, 관리자는 [인수인계]를 쓰세요.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {workers.map((w) => (
            <div key={w} className="flex items-center gap-2">
              <Input
                value={edits[w] ?? w}
                onChange={(e) => setEdits((prev) => ({ ...prev, [w]: e.target.value }))}
                className="h-9"
              />
              <span className="text-xs text-muted-foreground w-16 shrink-0">
                대상자 {countOf(w)}명
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === w || (edits[w] ?? w).trim() === w}
                onClick={() => rename(w)}
              >
                {busy === w ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                변경
              </Button>
            </div>
          ))}
          {workers.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">담당자가 없습니다.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
