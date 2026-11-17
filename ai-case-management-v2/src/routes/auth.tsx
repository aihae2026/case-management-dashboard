import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { listOrgNames, verifyJoinCode } from "@/lib/org.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { HeartHandshake, CheckCircle2, AlertTriangle, XCircle, BookOpen } from "lucide-react";
import { UserGuideDialog } from "@/components/UserGuideDialog";

export const Route = createFileRoute("/auth")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    next: typeof s.next === "string" && s.next.startsWith("/") && !s.next.startsWith("//") ? s.next : "",
  }),
  component: AuthPage,
});

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

// 기관명 유사도 계산 (중복검사용)
function normalizeOrg(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[m];
}
function orgSimilarity(a: string, b: string): number {
  const x = normalizeOrg(a), y = normalizeOrg(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const lev = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  const contains = x.includes(y) || y.includes(x) ? Math.min(x.length, y.length) / Math.max(x.length, y.length) : 0;
  return Math.max(lev, contains);
}
const SIMILAR_THRESHOLD = 0.8;

type OrgOption = { id: string; name: string };
type DupResult = { status: "ok" | "similar" | "dup"; matches: string[] };

function AuthPage() {
  const [loading, setLoading] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [orgName, setOrgName] = useState("");
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkedName, setCheckedName] = useState("");
  const [dupResult, setDupResult] = useState<DupResult | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [signupMode, setSignupMode] = useState<"new" | "code">("new");

  const fetchOrgNames = useServerFn(listOrgNames);
  const runVerifyCode = useServerFn(verifyJoinCode);
  const { next } = Route.useSearch();
  const postAuthTarget = next || "/";

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) window.location.assign(postAuthTarget);
    });
    loadOrgs();
  }, [postAuthTarget]);

  async function loadOrgs(): Promise<OrgOption[]> {
    const sortSet = (list: OrgOption[]) => {
      const seen = new Set<string>();
      const deduped = list.filter((o) => {
        const key = (o.name ?? "").trim();
        if (!o.id || !key) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const sorted = deduped.sort((a, b) => a.name.localeCompare(b.name, "ko"));
      setOrgs(sorted);
      return sorted;
    };
    try {
      const res = await fetchOrgNames();
      if (res?.orgs?.length) return sortSet(res.orgs);
    } catch { /* 폴백 */ }
    const { data, error } = await supabase.rpc("list_org_names" as Parameters<typeof supabase.rpc>[0]);
    if (!error && data) return sortSet(data as OrgOption[]);
    return [];
  }

  const isChecked = dupResult !== null && checkedName === orgName.trim();

  async function runDupCheck() {
    const q = orgName.trim();
    if (!q) return toast.error("기관명을 입력해주세요.");
    setChecking(true);
    let list = orgs;
    if (list.length === 0) list = await loadOrgs();
    setChecking(false);
    const exact = list.find((o) => normalizeOrg(o.name) === normalizeOrg(q));
    if (exact) { setCheckedName(q); setDupResult({ status: "dup", matches: [exact.name] }); return; }
    const similar = list
      .map((o) => ({ name: o.name, score: orgSimilarity(o.name, q) }))
      .filter((x) => x.score >= SIMILAR_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.name);
    setCheckedName(q);
    setDupResult(similar.length > 0 ? { status: "similar", matches: similar } : { status: "ok", matches: [] });
  }

  async function signInWithGoogle() {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}${postAuthTarget}` },
    });
    if (error) { setLoading(false); toast.error(error.message); }
  }

  async function signUpWithGoogle(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return toast.error("담당자 이름을 입력해주세요.");
    if (!phone.trim()) return toast.error("연락처를 입력해주세요.");
    const code = joinCode.trim();
    const org = orgName.trim();
    const joining = code.length > 0;

    if (joining) {
      // 기관코드로 참여 — 코드 유효성 검증
      setLoading(true);
      let verifyResult: { ok: boolean; orgName: string | null };
      try {
        verifyResult = await runVerifyCode({ data: { code } });
      } catch {
        setLoading(false);
        return toast.error("코드 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
      }
      setLoading(false);
      if (!verifyResult.ok) return toast.error("올바르지 않은 기관코드입니다. 기관 관리자에게 코드를 다시 확인해주세요.");
      toast.message(`"${verifyResult.orgName}" 기관으로 합류합니다.`, { duration: 2000 });
    } else {
      // 신규 기관 생성 — 기관명과 중복검사 필요
      if (!org) return toast.error("기관명을 입력하거나 기관코드를 입력해주세요.");
      if (!isChecked) return toast.error("기관명 중복검사를 먼저 진행해주세요.");
      if (dupResult?.status === "dup") return toast.error("이미 등록된 기관입니다. '기관코드로 합류'를 선택해주세요.");
    }

    // Google OAuth 전 임시 저장 (onboarding에서 읽음)
    try {
      localStorage.setItem("pending_signup", JSON.stringify({
        name: name.trim(),
        phone: phone.trim(),
        org_name: joining ? "" : org,
        join_code: joining ? code.toUpperCase() : "",
      }));
    } catch { /* ignore */ }

    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/` },
    });
    if (error) { setLoading(false); toast.error(error.message); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-background via-secondary/40 to-accent/30">
      <Toaster richColors position="top-center" />
      <UserGuideDialog open={guideOpen} onOpenChange={setGuideOpen} />
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="h-14 w-14 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center shadow-lg shadow-primary/20">
            <HeartHandshake className="h-7 w-7" />
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight">통합 사례관리</h1>
          <p className="text-sm text-muted-foreground mt-1">복지 현장을 위한 AI 대시보드</p>
        </div>
        <Card className="shadow-xl border-border/60">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">시작하기</CardTitle>
            <CardDescription>Google 계정으로 로그인하거나 새 기관을 등록하세요.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="signin">
              <TabsList className="grid grid-cols-2 w-full mb-4">
                <TabsTrigger value="signin">로그인</TabsTrigger>
                <TabsTrigger value="signup">신규 등록</TabsTrigger>
              </TabsList>

              {/* 로그인 탭 */}
              <TabsContent value="signin">
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    기존에 가입한 담당자는 아래 버튼으로 로그인하세요.
                  </p>
                  <Button onClick={signInWithGoogle} disabled={loading} variant="outline" className="w-full gap-3 h-11">
                    <GoogleIcon />
                    {loading ? "연결 중..." : "Google로 로그인"}
                  </Button>
                </div>
              </TabsContent>

              {/* 신규 등록 탭 */}
              <TabsContent value="signup">
                <form onSubmit={signUpWithGoogle} className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">담당자 이름</label>
                    <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="홍길동" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">연락처 <span className="text-destructive">*</span></label>
                    <Input
                      required
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="예) 010-1234-5678"
                      type="tel"
                    />
                  </div>

                  {/* 가입 방식 선택 */}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => { setSignupMode("new"); setJoinCode(""); }}
                      className={`rounded-lg border px-3 py-2.5 text-sm transition-colors text-left ${
                        signupMode === "new"
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border text-muted-foreground hover:bg-accent"
                      }`}
                    >
                      <div className="font-semibold">신규 기관 등록</div>
                      <div className="text-xs mt-0.5 opacity-70">기관명으로 새로 만들기</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => { setSignupMode("code"); setOrgName(""); setDupResult(null); setCheckedName(""); }}
                      className={`rounded-lg border px-3 py-2.5 text-sm transition-colors text-left ${
                        signupMode === "code"
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border text-muted-foreground hover:bg-accent"
                      }`}
                    >
                      <div className="font-semibold">기관코드로 가입</div>
                      <div className="text-xs mt-0.5 opacity-70">코드 받은 경우</div>
                    </button>
                  </div>

                  {/* 신규 기관 등록 */}
                  {signupMode === "new" && (
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">기관명</label>
                      <div className="flex gap-2">
                        <Input
                          value={orgName}
                          onChange={(e) => { setOrgName(e.target.value); setDupResult(null); setCheckedName(""); }}
                          placeholder="예) 햇살종합사회복지관"
                        />
                        <Button type="button" variant="outline" onClick={runDupCheck} disabled={checking} className="shrink-0">
                          {checking ? "확인 중..." : "중복검사"}
                        </Button>
                      </div>
                      {isChecked && dupResult?.status === "ok" && (
                        <div className="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-400">
                          <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                          <span>사용 가능한 기관명입니다. 가입 후 자동 부여된 기관코드를 담당자들에게 공유하세요.</span>
                        </div>
                      )}
                      {isChecked && dupResult?.status === "similar" && (
                        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                          <span>이름이 비슷한 기관이 있어요: {dupResult.matches.map((m) => `[${m}]`).join(", ")}<br />같은 기관이라면 <b>기관코드로 가입</b>을 선택해주세요.</span>
                        </div>
                      )}
                      {isChecked && dupResult?.status === "dup" && (
                        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                          <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                          <span>이미 등록된 기관입니다. 기관코드 확인 후 <b>기관코드로 가입</b>을 선택해주세요.</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 기관코드로 가입 */}
                  {signupMode === "code" && (
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">기관코드</label>
                      <Input
                        value={joinCode}
                        onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                        placeholder="예) A7K2M9QR"
                        maxLength={12}
                        className="uppercase tracking-widest font-mono"
                        autoFocus
                      />
                      <p className="text-xs text-muted-foreground">기관 관리자에게 받은 코드를 입력하세요.</p>
                    </div>
                  )}

                  <Button type="submit" disabled={loading} className="w-full gap-3 h-11">
                    <GoogleIcon />
                    {loading ? "연결 중..." : "Google로 회원가입"}
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
        <p className="text-center text-xs text-muted-foreground mt-6">
          가입 후 소속 기관 정보를 설정하면 사례관리를 시작할 수 있습니다.
        </p>
        <p className="text-center text-xs text-muted-foreground mt-3">
          <a href="/privacy" className="underline underline-offset-2 hover:text-foreground transition-colors">
            개인정보처리방침
          </a>
        </p>
        <div className="flex justify-center mt-3">
          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <BookOpen className="h-3.5 w-3.5" />
            이용자 가이드 보기
          </button>
        </div>
      </div>
    </div>
  );
}
