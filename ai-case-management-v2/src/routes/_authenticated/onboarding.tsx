import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { deleteAccount } from "@/lib/account.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Building2, Plus, X, LogOut, AlertTriangle, Clock } from "lucide-react";

export const Route = createFileRoute("/_authenticated/onboarding")({
  component: OnboardingPage,
});

const ORG_TYPES = ["종합사회복지관", "노인복지관", "장애인복지관", "아동/청소년복지관", "가족센터", "정신건강복지센터", "기타"];
const PRESET_TYPES = ["노인", "장애인", "아동", "청소년", "가족", "한부모", "다문화", "자원봉사자", "후원자"];

function OnboardingPage() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [orgType, setOrgType] = useState(ORG_TYPES[0]);
  const [types, setTypes] = useState<string[]>(["노인", "장애인", "아동", "가족"]);
  const [custom, setCustom] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [noOrgWarning, setNoOrgWarning] = useState(false); // 기관 없는 계정이 로그인 탭으로 들어온 경우
  const [pendingPhone, setPendingPhone] = useState(""); // 가입 시 입력한 연락처
  const runDelete = useServerFn(deleteAccount);

  async function handleDelete() {
    setDeleting(true);
    try {
      await runDelete();
      await supabase.auth.signOut();
      toast.success("계정이 삭제되었습니다.");
      window.location.assign("/auth");
    } catch (e) {
      setDeleting(false);
      toast.error("탈퇴 실패: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  useEffect(() => {
    (async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) return navigate({ to: "/auth", search: { next: "" } });
      // org_id + status 한 번에 조회
      const { data: profileFull } = await supabase
        .from("profiles")
        .select("org_id, status")
        .eq("id", userRes.user.id)
        .maybeSingle();
      if (profileFull?.org_id) {
        if ((profileFull.status as string) === "pending") {
          // 이전 세션에서 가입 완료, 아직 승인 대기 중
          setPendingApproval(true);
          setChecking(false);
          return;
        }
        return navigate({ to: "/" });
      }
      // localStorage에서 회원가입 시 입력한 정보 읽기 (Google OAuth 가입 흐름)
      let pendingName = "";
      let localPhone = "";
      let pendingOrgName = "";
      let pendingJoinCode = "";
      let hasPendingSignup = false;
      let rawSignup: string | null = null;
      try {
        rawSignup = localStorage.getItem("pending_signup");
        if (rawSignup) {
          hasPendingSignup = true;
          const parsed = JSON.parse(rawSignup) as { name?: string; phone?: string; org_name?: string; join_code?: string };
          pendingName = parsed.name?.trim() ?? "";
          localPhone = parsed.phone?.trim() ?? "";
          pendingOrgName = parsed.org_name?.trim() ?? "";
          pendingJoinCode = parsed.join_code?.trim() ?? "";
          localStorage.removeItem("pending_signup"); // 한 번 읽으면 삭제
          if (localPhone) setPendingPhone(localPhone);
        }
      } catch { /* ignore */ }

      const joinCode = (userRes.user.user_metadata?.join_code as string | undefined)?.trim() || pendingJoinCode;
      const displayName = (userRes.user.user_metadata?.name as string | undefined)?.trim()
        || pendingName
        || userRes.user.email?.split("@")[0]
        || "담당자";

      if (joinCode) {
        const { data: joined, error } = await supabase.rpc("join_org_by_code", { _code: joinCode });
        if (error) {
          // 오류 시 pending_signup 복원 → 사용자가 새로고침해도 재시도 가능
          if (rawSignup) localStorage.setItem("pending_signup", rawSignup);
          toast.error(`기관 참여 실패: ${error.message}. 새 기관을 만들거나 관리자에게 코드를 확인하세요.`);
          setChecking(false);
          return;
        }
        // join_org_by_code는 profiles를 UPDATE하므로 프로필 행이 없으면 org_id가 안 채워진다.
        // 프로필이 없을 수 있으니 upsert로 보정한다. status = 'pending' (관리자 승인 대기)
        const joinedOrg = Array.isArray(joined) ? joined[0] : joined;
        if (joinedOrg?.id) {
          const upsertData: Record<string, unknown> = {
            id: userRes.user.id,
            name: displayName,
            email: userRes.user.email,
            org_id: joinedOrg.id,
            status: "pending",
          };
          if (localPhone) upsertData.phone = localPhone;
          await supabase.from("profiles").upsert(upsertData as never, { onConflict: "id" });
        }
        // 승인 대기 화면 표시 (navigate 하지 않음)
        setPendingApproval(true);
        setChecking(false);
        return;
      }
      const preset = (userRes.user.user_metadata?.org_name as string | undefined)?.trim() || pendingOrgName;
      if (preset) setOrgName(preset);

      // pending_signup도 없고 user_metadata에도 정보가 없으면 → 로그인 탭으로 잘못 들어온 계정
      if (!hasPendingSignup && !preset) {
        setNoOrgWarning(true);
        setChecking(false);
        return;
      }

      setChecking(false);
    })();
  }, [navigate]);

  function toggle(t: string) {
    setTypes((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]);
  }

  function addCustom() {
    const v = custom.trim();
    if (!v || types.includes(v)) return;
    setTypes([...types, v]);
    setCustom("");
  }

  /** 기존 코드와 중복되지 않는 8자리 기관코드 생성 */
  async function generateUniqueJoinCode(): Promise<string> {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 혼동 문자(O,0,I,1) 제외
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = "";
      for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
      const { data } = await supabase.from("organizations").select("id").eq("join_code", code).maybeSingle();
      if (!data) return code; // 중복 없으면 사용
    }
    return Math.random().toString(36).slice(2, 10).toUpperCase(); // 최후 폴백
  }

  /** 기존 slug와 중복되지 않는 6자리 URL slug 생성 */
  async function generateUniqueSlug(): Promise<string> {
    const chars = "abcdefghjkmnpqrstuvwxyz23456789"; // 혼동 문자 제외, 소문자
    for (let attempt = 0; attempt < 20; attempt++) {
      let slug = "";
      for (let i = 0; i < 6; i++) slug += chars[Math.floor(Math.random() * chars.length)];
      const { data } = await supabase.from("organizations").select("id").eq("slug", slug).maybeSingle();
      if (!data) return slug;
    }
    return Math.random().toString(36).slice(2, 8); // 최후 폴백
  }

  async function save() {
    if (!orgName.trim()) return toast.error("기관명을 입력해주세요.");
    if (types.length === 0) return toast.error("최소 1개의 대상자군을 선택해주세요.");
    setSaving(true);
    const { data: userRes } = await supabase.auth.getUser();
    if (!userRes.user) { setSaving(false); return toast.error("세션이 만료되었습니다. 다시 로그인해주세요."); }
    const user = userRes.user;
    const [joinCode, slug] = await Promise.all([generateUniqueJoinCode(), generateUniqueSlug()]);
    const { data: org, error: orgErr } = await supabase.from("organizations").insert({
      name: orgName.trim(), org_type: orgType, client_types: types, created_by: user.id, join_code: joinCode, slug,
    }).select().single();
    if (orgErr || !org) { setSaving(false); return toast.error(orgErr?.message ?? "오류"); }
    // upsert: 신규 가입자는 profiles 행이 아직 없을 수 있으므로 update 대신 upsert로 자가 생성한다.
    const profData: Record<string, unknown> = {
      id: user.id,
      name: (user.user_metadata?.name as string | undefined)?.trim() || user.email?.split("@")[0] || "담당자",
      email: user.email,
      org_id: org.id,
    };
    if (pendingPhone) profData.phone = pendingPhone;
    const { error: profErr } = await supabase.from("profiles").upsert(profData as never, { onConflict: "id" });
    setSaving(false);
    if (profErr) {
      // profiles 저장 실패 → 방금 생성한 기관 롤백 (고아 기관 방지)
      await supabase.from("organizations").delete().eq("id", org.id);
      return toast.error(profErr.message);
    }
    toast.success("기관 설정이 완료되었습니다.");
    navigate({ to: "/$slug", params: { slug }, search: { tab: undefined } });
  }

  if (checking) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">불러오는 중...</div>;

  // 기관 없는 계정이 로그인 탭으로 들어온 경우 — 안내 화면
  if (noOrgWarning) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-secondary/30 to-accent/20 px-4">
        <Toaster richColors position="top-center" />
        <Card className="w-full max-w-md text-center">
          <CardHeader className="pb-4">
            <div className="mx-auto mb-3 h-14 w-14 rounded-full bg-blue-100 flex items-center justify-center">
              <AlertTriangle className="h-7 w-7 text-blue-600" />
            </div>
            <CardTitle className="text-xl">소속 기관이 없는 계정</CardTitle>
            <CardDescription className="text-sm leading-relaxed mt-1">
              이 Google 계정은 아직 어떤 기관에도 등록되지 않았습니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pb-6">
            <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-800 text-left leading-relaxed">
              <b>신규 기관 등록</b>이 필요하다면 로그아웃 후<br />
              로그인 화면의 <b>"신규 등록"</b> 탭에서 진행해주세요.<br /><br />
              기존 기관에 합류하려면 기관 관리자에게<br />
              <b>기관코드</b>를 요청해 신규 등록 탭에서 입력하세요.
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={async () => { await supabase.auth.signOut(); window.location.assign("/auth"); }}
            >
              <LogOut className="h-4 w-4 mr-2" />
              로그아웃
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // 승인 대기 화면
  if (pendingApproval) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-secondary/30 to-accent/20 px-4">
        <Toaster richColors position="top-center" />
        <Card className="w-full max-w-md text-center">
          <CardHeader className="pb-4">
            <div className="mx-auto mb-3 h-14 w-14 rounded-full bg-amber-100 flex items-center justify-center">
              <Clock className="h-7 w-7 text-amber-600" />
            </div>
            <CardTitle className="text-xl">가입 신청 완료</CardTitle>
            <CardDescription className="text-sm leading-relaxed mt-1">
              기관코드 인증이 완료됐습니다.<br />
              <strong>관리자 승인</strong> 후 로그인할 수 있습니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pb-6">
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
              기관 관리자가 <strong>기관 멤버</strong> 탭에서 승인하면<br />
              자동으로 대시보드에 접근할 수 있습니다.
            </div>
            <p className="text-xs text-muted-foreground">
              승인 후 이 페이지를 새로고침하거나 다시 로그인해 주세요.
            </p>
            <Button
              variant="outline"
              className="w-full mt-2"
              onClick={async () => {
                await supabase.auth.signOut();
                window.location.assign("/auth");
              }}
            >
              <LogOut className="h-4 w-4 mr-1.5" />
              로그아웃
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen py-10 px-4 bg-gradient-to-br from-background via-secondary/30 to-accent/20">
      <Toaster richColors position="top-center" />
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center"><Building2 className="h-5 w-5" /></div>
          <div>
            <h1 className="text-xl font-bold">기관 초기 설정</h1>
            <p className="text-sm text-muted-foreground">이 정보로 대상자 유형과 대시보드가 구성됩니다.</p>
          </div>
        </div>

        <Card>
          <CardHeader><CardTitle>기관 정보</CardTitle><CardDescription>기관명과 유형을 선택해주세요.</CardDescription></CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label>기관명</Label>
              <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="예) 햇살종합사회복지관" />
            </div>
            <div className="space-y-2">
              <Label>기관 유형</Label>
              <RadioGroup value={orgType} onValueChange={setOrgType} className="grid grid-cols-2 gap-2">
                {ORG_TYPES.map((t) => (
                  <label key={t} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 cursor-pointer hover:bg-accent has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent">
                    <RadioGroupItem value={t} /> <span className="text-sm">{t}</span>
                  </label>
                ))}
              </RadioGroup>
            </div>
          </CardContent>
        </Card>

        <Card className="mt-4">
          <CardHeader><CardTitle>관리 대상자군</CardTitle><CardDescription>기관에서 관리할 이용자 유형을 선택하세요. 필요한 항목을 자유롭게 추가할 수 있습니다.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {PRESET_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 cursor-pointer hover:bg-accent has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent">
                  <Checkbox checked={types.includes(t)} onCheckedChange={() => toggle(t)} />
                  <span className="text-sm">{t}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <Input placeholder="직접 추가 (예: 결연아동)" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCustom())} />
              <Button type="button" variant="outline" onClick={addCustom}><Plus className="h-4 w-4" />추가</Button>
            </div>
            {types.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-2 border-t">
                {types.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-3 py-1 text-xs">
                    {t} <button onClick={() => toggle(t)}><X className="h-3 w-3" /></button>
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="mt-6 flex justify-end">
          <Button size="lg" onClick={save} disabled={saving}>{saving ? "저장 중..." : "설정 완료하고 시작하기"}</Button>
        </div>

        {/* 로그아웃 / 계정 탈퇴 */}
        <div className="mt-8 border-t border-border pt-4 space-y-3">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.assign("/auth");
            }}
          >
            <LogOut className="h-4 w-4 mr-1.5" />
            로그아웃
          </Button>
          <details>
            <summary className="text-xs text-muted-foreground cursor-pointer text-center hover:text-foreground select-none">
              계정 삭제
            </summary>
            <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                회원 탈퇴
              </div>
              <p className="text-xs text-muted-foreground">
                계정을 영구 삭제합니다. 아래에 <b>탈퇴</b>라고 입력한 뒤 버튼을 클릭하세요.
              </p>
              <div className="flex gap-2">
                <Input
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder='"탈퇴" 입력'
                  className="h-8 text-sm"
                />
                <Button
                  variant="destructive"
                  size="sm"
                  className="shrink-0"
                  disabled={deleteConfirm.trim() !== "탈퇴" || deleting}
                  onClick={handleDelete}
                >
                  {deleting ? "삭제 중..." : "탈퇴하기"}
                </Button>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}