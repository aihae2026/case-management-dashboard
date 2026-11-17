import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getSuperAdminOrgs, deleteSuperAdminOrg, type OrgRow } from "@/lib/superadmin.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Building2, Users, Trash2, RefreshCw, ShieldCheck, LogOut } from "lucide-react";
import { ORG_NAME } from "@/lib/org-config";

export const Route = createFileRoute("/admin")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "사례관리 관리자" },
      { name: "theme-color", content: "#2c2c2c" },
      { name: "apple-mobile-web-app-title", content: "사례관리 관리자" },
    ],
    links: [
      { rel: "manifest", href: "/manifest-admin.json" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon-admin.png" },
    ],
  }),
  component: AdminPage,
});

const PROTECTED_ORG_NAME = ORG_NAME;

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

type AdminState = "loading" | "login" | "wrong_account" | "panel";

function AdminPage() {
  const runGetOrgs = useServerFn(getSuperAdminOrgs);
  const runDeleteOrg = useServerFn(deleteSuperAdminOrg);

  const [adminState, setAdminState] = useState<AdminState>("loading");
  const [currentEmail, setCurrentEmail] = useState("");
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<OrgRow | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function loadOrgs() {
    setOrgsLoading(true);
    try {
      const data = await runGetOrgs();
      setOrgs(data as OrgRow[]);
    } catch (e) {
      toast.error("데이터 로드 실패: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setOrgsLoading(false);
    }
  }

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const email = data.user?.email ?? "";
      setCurrentEmail(email);
      if (!email) {
        setAdminState("login");
        return;
      }
      // 슈퍼 관리자인지는 서버가 판정한다(이메일 목록을 화면 코드에 두지 않음). 권한이 없으면 서버가 거절한다.
      runGetOrgs()
        .then((rows) => {
          setOrgs(rows as OrgRow[]);
          setAdminState("panel");
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("권한 없음")) {
            setAdminState("wrong_account");
          } else {
            toast.error("데이터 로드 실패: " + msg);
            setAdminState("login");
          }
        });
    });
  }, []);

  async function signInWithGoogle() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href },
    });
    if (error) toast.error(error.message);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setAdminState("login");
    setCurrentEmail("");
    setOrgs([]);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await runDeleteOrg({ data: { orgId: deleteTarget.id } as never });
      toast.success(`"${deleteTarget.name}" 기관이 삭제되었습니다.`);
      setDeleteTarget(null);
      setConfirmText("");
      await loadOrgs();
    } catch (e) {
      toast.error("삭제 실패: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setDeleting(false);
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
  }

  /* ── 로딩 ── */
  if (adminState === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
        확인 중...
      </div>
    );
  }

  /* ── 구글 로그인 화면 ── */
  if (adminState === "login") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-secondary/30 to-accent/20 px-4">
        <Toaster richColors position="top-center" />
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center pb-4">
            <div className="mx-auto mb-3 h-14 w-14 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center">
              <ShieldCheck className="h-7 w-7" />
            </div>
            <CardTitle className="text-lg leading-snug">
              통합 사례관리 대시보드<br />관리자 패널
            </CardTitle>
            <CardDescription className="text-sm mt-1">
              관리자 Google 계정으로 로그인하세요.
            </CardDescription>
          </CardHeader>
          <CardContent className="pb-6">
            <Button onClick={signInWithGoogle} className="w-full gap-2.5" variant="outline" size="lg">
              <GoogleIcon />
              Google로 로그인
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* ── 권한 없는 계정 ── */
  if (adminState === "wrong_account") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-secondary/30 to-accent/20 px-4">
        <Toaster richColors position="top-center" />
        <Card className="w-full max-w-sm text-center">
          <CardHeader className="pb-3">
            <div className="mx-auto mb-3 h-14 w-14 rounded-2xl bg-destructive/10 flex items-center justify-center">
              <ShieldCheck className="h-7 w-7 text-destructive" />
            </div>
            <CardTitle className="text-lg">접근 권한 없음</CardTitle>
            <CardDescription className="text-sm mt-1">
              <strong>{currentEmail}</strong> 계정은<br />관리자 권한이 없습니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="pb-6 space-y-2">
            <Button onClick={signOut} variant="outline" className="w-full gap-2">
              <LogOut className="h-4 w-4" />
              로그아웃 후 다시 시도
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* ── 관리자 패널 ── */
  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/20 to-accent/10 px-4 py-8">
      <Toaster richColors position="top-center" />

      <div className="max-w-4xl mx-auto space-y-6">
        {/* 헤더 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold leading-snug">통합 사례관리 대시보드<br className="sm:hidden" /> 관리자 패널</h1>
              <p className="text-sm text-muted-foreground">{currentEmail}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={loadOrgs} disabled={orgsLoading}>
              <RefreshCw className={`h-4 w-4 mr-1.5 ${orgsLoading ? "animate-spin" : ""}`} />
              새로고침
            </Button>
            <Button variant="ghost" size="sm" onClick={signOut} className="text-muted-foreground">
              <LogOut className="h-4 w-4 mr-1.5" />
              로그아웃
            </Button>
          </div>
        </div>

        {/* 요약 카드 */}
        <div className="grid grid-cols-2 gap-4">
          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <Building2 className="h-8 w-8 text-primary/60" />
                <div>
                  <p className="text-2xl font-bold">{orgs.length}</p>
                  <p className="text-xs text-muted-foreground">가입 기관 수</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <Users className="h-8 w-8 text-primary/60" />
                <div>
                  <p className="text-2xl font-bold">{orgs.reduce((s, o) => s + o.member_count, 0)}</p>
                  <p className="text-xs text-muted-foreground">전체 담당자 수</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 기관 목록 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">기관 목록</CardTitle>
            <CardDescription>가입일 최신순</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {orgsLoading ? (
              <div className="py-12 text-center text-sm text-muted-foreground">불러오는 중...</div>
            ) : orgs.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">가입된 기관이 없습니다.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">기관명</th>
                      <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">유형</th>
                      <th className="px-4 py-2.5 text-center font-medium text-muted-foreground">담당자</th>
                      <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">접속 URL</th>
                      <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">기관코드</th>
                      <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">가입일</th>
                      <th className="px-4 py-2.5 text-center font-medium text-muted-foreground">관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orgs.map((org) => (
                      <tr key={org.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3 font-medium">{org.name}</td>
                        <td className="px-4 py-3 text-muted-foreground">{org.org_type ?? "—"}</td>
                        <td className="px-4 py-3 text-center">
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <Users className="h-3.5 w-3.5" />
                            {org.member_count}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {org.slug ? (
                            <a
                              href={`/${org.slug}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-xs text-primary hover:underline"
                            >
                              /{org.slug}
                            </a>
                          ) : (
                            <span className="text-xs text-muted-foreground">미설정</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                            {org.join_code ?? "—"}
                          </code>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">{formatDate(org.created_at)}</td>
                        <td className="px-4 py-3 text-center">
                          {org.name === PROTECTED_ORG_NAME ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary font-medium">
                              보호됨
                            </span>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive hover:bg-destructive/10 h-7 px-2"
                              onClick={() => { setDeleteTarget(org); setConfirmText(""); }}
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-1" />
                              삭제
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 삭제 확인 다이얼로그 */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setConfirmText(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-destructive">기관 삭제</DialogTitle>
            <DialogDescription className="leading-relaxed pt-1">
              <strong>"{deleteTarget?.name}"</strong> 기관을 삭제하면<br />
              대상자·상담기록·목표·제공서비스·로그 등<br />
              <strong>모든 관련 데이터 및 담당자 계정이 영구 삭제</strong>됩니다.<br />
              이 작업은 되돌릴 수 없습니다.
              <br /><br />
              계속하려면 아래에 기관명을 정확히 입력하세요.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={deleteTarget?.name ?? "기관명 입력"}
              autoFocus
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setDeleteTarget(null); setConfirmText(""); }} disabled={deleting}>
              취소
            </Button>
            <Button
              variant="destructive"
              disabled={confirmText.trim() !== deleteTarget?.name || deleting}
              onClick={handleDelete}
            >
              {deleting ? "삭제 중..." : "삭제하기"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
