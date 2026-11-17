import { useEffect, useState } from "react";
import { clearResourceChat } from "@/lib/resource-chat-cache";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { deleteAccount } from "@/lib/account.functions";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { User, Phone, Mail, AlertTriangle, Stamp, Link2 } from "lucide-react";
import { DEFAULT_APPROVAL_ROLES, type ApprovalRole } from "@/lib/print-counsel";

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 헤더에 표시 중인 현재 담당자 이름 */
  currentName?: string;
  /** 저장 후 부모(대시보드)의 데이터를 새로고침 */
  onUpdated?: () => void;
};

export function AccountSettingsDialog({ open, onOpenChange, currentName, onUpdated }: Props) {
  const navigate = useNavigate();
  const runDelete = useServerFn(deleteAccount);

  const [userId, setUserId] = useState("");
  const [currentEmail, setCurrentEmail] = useState("");

  // 이름
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);

  // 연락처
  const [phone, setPhone] = useState("");
  const [savingPhone, setSavingPhone] = useState(false);


  // 결재라인
  const [approvalLine, setApprovalLine] = useState<ApprovalRole[]>(DEFAULT_APPROVAL_ROLES);
  const [savingApproval, setSavingApproval] = useState(false);

  // 구글 연결
  const [googleLinked, setGoogleLinked] = useState(false);
  const [linkingGoogle, setLinkingGoogle] = useState(false);

  // 탈퇴
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  // 다이얼로그가 열릴 때 현재 사용자 정보 로드 + 입력값 초기화
  useEffect(() => {
    if (!open) return;
    setConfirmText("");
    supabase.auth.getUser().then(async ({ data }) => {
      const uid = data.user?.id ?? "";
      setUserId(uid);
      setCurrentEmail(data.user?.email ?? "");
      setName(currentName ?? "");
      const identities = data.user?.identities ?? [];
      setGoogleLinked(identities.some((id) => id.provider === "google"));
      if (uid) {
        const { data: prof } = await supabase.from("profiles").select("approval_line, phone").eq("id", uid).single();
        setPhone((prof as { phone?: string | null } | null)?.phone ?? "");
        const raw = (prof as { approval_line?: unknown } | null)?.approval_line;
        if (Array.isArray(raw) && raw.length > 0) {
          // 구형 데이터 (name 필드) → 신형 (active 필드) 변환
          const migrated: ApprovalRole[] = DEFAULT_APPROVAL_ROLES.map((def) => {
            const found = (raw as Record<string, unknown>[]).find(r => r.role === def.role);
            if (!found) return def;
            // 신형이면 active 필드 사용, 구형이면 기본 true
            return { role: def.role, active: found.active !== undefined ? Boolean(found.active) : true };
          });
          setApprovalLine(migrated);
        }
      }
    });
  }, [open, currentName]);

  async function linkGoogle() {
    setLinkingGoogle(true);
    const { error } = await supabase.auth.linkIdentity({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    setLinkingGoogle(false);
    if (error) return toast.error("구글 연결 실패: " + error.message);
    // linkIdentity는 OAuth 팝업/리다이렉트를 시작함 — 성공 시 페이지가 이동됨
  }

  async function savePhone() {
    const trimmed = phone.trim();
    setSavingPhone(true);
    const { error } = await supabase.from("profiles").update({ phone: trimmed || null }).eq("id", userId);
    setSavingPhone(false);
    if (error) return toast.error("저장 실패: " + error.message);
    toast.success("연락처가 저장되었습니다.");
  }

  async function saveApprovalLine() {
    setSavingApproval(true);
    const { error } = await supabase.from("profiles").update({ approval_line: approvalLine } as never).eq("id", userId);
    setSavingApproval(false);
    if (error) return toast.error("저장 실패: " + error.message);
    toast.success("결재라인이 저장되었습니다.");
  }

  async function saveName() {
    const trimmed = name.trim();
    if (!trimmed) return toast.error("이름을 입력해주세요.");
    setSavingName(true);
    const { error } = await supabase.from("profiles").update({ name: trimmed }).eq("id", userId);
    if (!error) await supabase.auth.updateUser({ data: { name: trimmed } }).catch(() => {});
    setSavingName(false);
    if (error) return toast.error("이름 변경 실패: " + error.message);
    toast.success("이름이 변경되었습니다.");
    onUpdated?.();
  }

  async function handleDelete() {
    if (confirmText.trim() !== "탈퇴")
      return toast.error('확인란에 "탈퇴"라고 정확히 입력해주세요.');
    setDeleting(true);
    try {
      await runDelete();
      clearResourceChat();
      await supabase.auth.signOut();
      toast.success("회원 탈퇴가 완료되었습니다.");
      onOpenChange(false);
      navigate({ to: "/auth", search: { next: "" } });
    } catch (e) {
      setDeleting(false);
      toast.error("탈퇴 처리 실패: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>계정 설정</DialogTitle>
          <DialogDescription>
            담당자 정보를 수정하거나 회원 탈퇴를 할 수 있습니다.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* 이름 수정 */}
          <section className="space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <User className="h-4 w-4" />
              이름
            </div>
            <div className="flex gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="담당자 이름"
              />
              <Button onClick={saveName} disabled={savingName} className="shrink-0">
                {savingName ? "저장 중..." : "저장"}
              </Button>
            </div>
          </section>

          {/* 연락처 */}
          <section className="space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Phone className="h-4 w-4" />
              연락처
            </div>
            <div className="flex gap-2">
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="예) 010-1234-5678"
                type="tel"
              />
              <Button onClick={savePhone} disabled={savingPhone} className="shrink-0">
                {savingPhone ? "저장 중..." : "저장"}
              </Button>
            </div>
          </section>

          {/* 결재라인 설정 */}
          <section className="space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Stamp className="h-4 w-4" />
              상담기록서 결재라인
            </div>
            <p className="text-xs text-muted-foreground">
              출력 시 포함할 결재 직책을 선택하세요. 눌러서 활성·비활성 전환, 활성화된 항목만 출력됩니다.
            </p>
            <div className="flex gap-1.5 flex-wrap">
              {approvalLine.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setApprovalLine(prev => prev.map((x, j) => j === i ? { ...x, active: !x.active } : x))}
                  className={`px-3 py-1.5 rounded-md border text-sm font-medium transition-colors ${
                    r.active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-muted-foreground border-border hover:bg-accent"
                  }`}
                >
                  {r.role}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              활성화: {approvalLine.filter(r => r.active).map(r => r.role).join(" · ") || "없음"}
            </p>
            <Button onClick={saveApprovalLine} disabled={savingApproval} variant="outline" className="w-full">
              {savingApproval ? "저장 중..." : "결재라인 저장"}
            </Button>
          </section>

          {/* Google 계정 연결 */}
          <section className="space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Link2 className="h-4 w-4" />
              Google 계정 연결
            </div>
            {googleLinked ? (
              <div className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2.5 text-sm text-green-700 dark:text-green-400">
                <GoogleIcon />
                <span>Google 계정이 연결되어 있습니다. Google로 로그인할 수 있습니다.</span>
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Google 계정을 연결하면 이후 Google로도 로그인할 수 있습니다. 기존 데이터는 그대로 유지됩니다.
                </p>
                <Button onClick={linkGoogle} disabled={linkingGoogle} variant="outline" className="w-full gap-2">
                  <GoogleIcon />
                  {linkingGoogle ? "연결 중..." : "Google 계정 연결하기"}
                </Button>
              </>
            )}
          </section>

          {/* 연동 Google 계정 (읽기 전용) */}
          <section className="space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Mail className="h-4 w-4" />
              연동 이메일
            </div>
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              {currentEmail || "이메일 정보 없음"}
            </div>
            <p className="text-xs text-muted-foreground">Google 계정에서 관리되는 이메일입니다.</p>
          </section>

          {/* 회원 탈퇴 */}
          <section className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-destructive">
              <AlertTriangle className="h-4 w-4" />
              회원 탈퇴
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              탈퇴하면 계정이 <b>영구 삭제</b>되어 되돌릴 수 없습니다. 기관·대상자 데이터는 삭제되지
              않고 남지만, 담당자 연결은 해제됩니다. 계속하려면 아래에 <b>탈퇴</b> 라고 입력하세요.
            </p>
            <div className="flex gap-2">
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder='"탈퇴" 입력'
              />
              <Button
                onClick={handleDelete}
                disabled={deleting || confirmText.trim() !== "탈퇴"}
                variant="destructive"
                className="shrink-0"
              >
                {deleting ? "처리 중..." : "탈퇴하기"}
              </Button>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
