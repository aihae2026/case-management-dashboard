import { PrivacyPolicyDialog } from "@/components/PrivacyPolicyDialog";
import { clearResourceChat } from "@/lib/resource-chat-cache";
import { DriveViewerHost } from "@/components/DriveViewerHost";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TabErrorBoundary } from "@/components/TabErrorBoundary";
import { useServerFn } from "@tanstack/react-start";
import { getClientIp } from "@/lib/client-ip.functions";
import { logAccessOncePerVisit, logLogout } from "@/lib/access-log";
import { setViewLogContext } from "@/lib/view-log";
import { useCallback, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  HeartHandshake,
  Building2,
  LogOut,
  LayoutDashboard,
  Users,
  Target,
  Copy,
  UserCog,
  Settings,
  MessageSquarePlus,
  SlidersHorizontal,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  BookOpen,
  ShieldCheck,
  HeartPulse,
  Clock,
  HelpCircle,
} from "lucide-react";
import { toast } from "sonner";
import type { Client, ActivityLog, Provision, OrgRow, ProfileRow } from "@/lib/case-types";
import { fetchCarePlanActionLinks, type CarePlanLinkRow } from "@/lib/care-plan-links";
import { CounselTab } from "@/components/case/CounselTab";
import { OverviewTab } from "@/components/case/OverviewTab";
import { ClientsTab } from "@/components/case/ClientsTab";
import { ServiceGoalsTab } from "@/components/case/ServiceGoalsTab";
import { MembersTab } from "@/components/case/MembersTab";
import { ManualTab } from "@/components/case/ManualTab";
import { AdminTab } from "@/components/case/AdminTab";
import { CompanionMonitorTab } from "@/components/case/CompanionMonitorTab";
import { AccountSettingsDialog } from "@/components/AccountSettingsDialog";
import { UserGuideDialog } from "@/components/UserGuideDialog";
import { NameMaskProvider, NameMaskToggle } from "@/components/NameMask";

// 탭 정의 — 기본 순서: 상담(메인) → … → 매뉴얼(마지막)
const TAB_DEFS: { value: string; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { value: "counsel", label: "상담 및 제공이력", icon: MessageSquarePlus },
  { value: "clients", label: "대상자 관리", icon: Users },
  { value: "servicegoals", label: "사례관리 계획 점검", icon: Target },
  { value: "overview", label: "전체 현황", icon: LayoutDashboard },
  { value: "companion", label: "복순이 모니터링", icon: HeartPulse },
  { value: "members", label: "기관 멤버", icon: UserCog },
  { value: "manual", label: "매뉴얼", icon: BookOpen },
];
const DEFAULT_ORDER = TAB_DEFS.map((t) => t.value);
const tabOrderKey = (uid: string) => `tabOrder:${uid}`;
const tabHiddenKey = (uid: string) => `tabHidden:${uid}`;
// 기본으로 숨길 탭: 복순이 모니터링은 실사용 전이라 처음에는 보이지 않는다.
// 사용자가 [탭 설정]에서 직접 체크해 켠 경우에만 보이도록, 켰다는 표시를 따로 저장한다(예전에 저장된 탭 설정이 있어도 기본은 숨김).
const DEFAULT_HIDDEN = ["companion"];
const tabCompanionOnKey = (uid: string) => `tabCompanionOn:${uid}`;

/** 저장된 순서를 현재 탭 목록과 병합 (없는 탭 제거 · 새 탭은 뒤에 추가). */
function normalizeOrder(stored: string[]): string[] {
  const known = new Set(DEFAULT_ORDER);
  const merged = stored.filter((v) => known.has(v));
  DEFAULT_ORDER.forEach((v) => {
    if (!merged.includes(v)) merged.push(v);
  });
  return merged;
}

export const Route = createFileRoute("/_authenticated/$slug")({
  component: DashboardShell,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
});

function DashboardShell() {
  const navigate = useNavigate();
  const { slug } = Route.useParams();
  const { tab: tabParam } = Route.useSearch();
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const runGetIp = useServerFn(getClientIp);
  const [org, setOrg] = useState<OrgRow | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [provisions, setProvisions] = useState<Provision[]>([]);
  const [planLinks, setPlanLinks] = useState<CarePlanLinkRow[]>([]);
  const [logsFullyLoaded, setLogsFullyLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [tabOrder, setTabOrder] = useState<string[]>(DEFAULT_ORDER);
  const [tabHidden, setTabHidden] = useState<string[]>([]);
  // URL 파라미터 우선, 없으면 기본 탭
  const [activeTab, setActiveTab] = useState<string>(tabParam ?? DEFAULT_ORDER[0]);
  const [tabSettingsOpen, setTabSettingsOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isViewer, setIsViewer] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(false);
  // 복순이 모니터링 → 대상자 관리 포커스 연동
  const [focusClientId, setFocusClientId] = useState<string | null>(null);

  // 뒤로가기/앞으로가기 시 URL 파라미터 → 탭 상태 동기화
  useEffect(() => {
    if (tabParam && tabParam !== activeTab) setActiveTab(tabParam);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabParam]);

  // 사용자 탭 클릭 → URL 히스토리에 기록 (뒤로가기 가능)
  function handleTabChange(value: string) {
    setActiveTab(value);
    // @ts-expect-error TanStack Router search 타입이 /auth next와 /$slug tab을 병합해 오탐
    navigate({ search: (prev) => ({ ...prev, tab: value }) });
  }

  // 사용자별 탭 순서·표시설정 불러오기 (브라우저 저장)
  // 복순이 모니터링(companion)은 기본 숨김 — 탭 설정에서 사용자가 개별 활성화 가능
  useEffect(() => {
    if (!profile?.id || typeof window === "undefined") return;
    let order = DEFAULT_ORDER;
    let hidden: string[] = DEFAULT_HIDDEN;
    try {
      const stored = window.localStorage.getItem(tabOrderKey(profile.id));
      if (stored) order = normalizeOrder(JSON.parse(stored) as string[]);
      const h = window.localStorage.getItem(tabHiddenKey(profile.id));
      // 저장된 값이 있으면 그대로, 없으면 DEFAULT_HIDDEN 적용
      if (h !== null) hidden = (JSON.parse(h) as string[]).filter((v) => DEFAULT_ORDER.includes(v));
      // 복순이 모니터링은 사용자가 탭 설정에서 켠 경우에만 보인다
      const companionOn = window.localStorage.getItem(tabCompanionOnKey(profile.id)) === "1";
      hidden = companionOn
        ? hidden.filter((v) => v !== "companion")
        : hidden.includes("companion") ? hidden : [...hidden, "companion"];
    } catch {
      order = DEFAULT_ORDER;
      hidden = DEFAULT_HIDDEN;
    }
    setTabOrder(order);
    setTabHidden(hidden);
    // URL에 유효한 탭이 없을 때만 첫 번째 표시 탭으로 초기화
    const vis = order.filter((v) => !hidden.includes(v));
    if (!tabParam || !vis.includes(tabParam)) {
      const first = vis[0] ?? order[0];
      setActiveTab(first);
      // @ts-expect-error TanStack Router search 타입이 /auth next와 /$slug tab을 병합해 오탐
      navigate({ search: (prev) => ({ ...prev, tab: first }), replace: true });
    }
  }, [profile?.id]); // eslint-disable-line

  // 활성 탭이 숨겨지면 첫 번째 표시 탭으로 이동 (히스토리 교체)
  useEffect(() => {
    const vis = tabOrder.filter((v) => !tabHidden.includes(v));
    const list = [...(vis.length ? vis : tabOrder.slice(0, 1)), ...(isAdmin ? ["admin"] : [])];
    if (!list.includes(activeTab)) {
      setActiveTab(list[0]);
      // @ts-expect-error TanStack Router search 타입이 /auth next와 /$slug tab을 병합해 오탐
      navigate({ search: (prev) => ({ ...prev, tab: list[0] }), replace: true });
    }
  }, [tabOrder, tabHidden, activeTab, isAdmin]); // eslint-disable-line

  function saveTabPrefs(nextOrder: string[], nextHidden: string[]) {
    setTabOrder(nextOrder);
    setTabHidden(nextHidden);
    if (profile?.id && typeof window !== "undefined") {
      window.localStorage.setItem(tabOrderKey(profile.id), JSON.stringify(nextOrder));
      window.localStorage.setItem(tabHiddenKey(profile.id), JSON.stringify(nextHidden));
      window.localStorage.setItem(tabCompanionOnKey(profile.id), nextHidden.includes("companion") ? "0" : "1");
    }
  }

  // Supabase 서버 기본 max-rows=1000 우회: 페이지네이션으로 전체 로드
  async function fetchAllLogs(orgId: string): Promise<ActivityLog[]> {
    const PAGE = 1000;
    const all: ActivityLog[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("activity_logs")
        .select("*")
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true }) // 같은 시각 기록이 페이지 경계에서 중복·누락되지 않게
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...(data as ActivityLog[]));
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  // 제공이력도 상담기록처럼 1,000건씩 나눠 끝까지 읽는다(서버가 한 번에 1,000건까지만 주기 때문).
  // 같은 날짜 기록이 페이지 경계에서 중복·누락되지 않도록 id 로 한 번 더 정렬한다.
  async function fetchAllProvisions(orgId: string): Promise<{ data: Provision[]; error: { message: string } | null }> {
    const PAGE = 1000;
    const all: Provision[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("provisions")
        .select("*")
        .eq("org_id", orgId)
        .order("provided_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      // 중간에 실패하면 일부만 보여 주지 않고 오류로 알린다
      if (error) return { data: [], error };
      if (!data || data.length === 0) break;
      all.push(...(data as Provision[]));
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return { data: all, error: null };
  }

  const load = useCallback(async () => {
    try {
    const { data: userRes } = await supabase.auth.getUser();
    if (!userRes.user) return navigate({ to: "/auth", search: { next: "" } });
    const { data: prof } = await supabase
      .from("profiles")
      .select("id,name,org_id,status")
      .eq("id", userRes.user.id)
      .maybeSingle();
    if (!prof?.org_id) return navigate({ to: "/onboarding" });
    // 관리자 미승인 상태 — 대기 화면 표시
    if ((prof as { status?: string }).status === "pending") {
      setPendingApproval(true);
      setLoading(false);
      return;
    }
    setProfile(prof as ProfileRow);

    // 관리자 여부 확인
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userRes.user.id)
      .eq("org_id", prof.org_id)
      .eq("role", "admin")
      .maybeSingle();
    setIsAdmin(!!roleRow);

    // 뷰어 여부 확인 (관리자가 아닌 경우만)
    if (!roleRow) {
      const { data: viewerRow } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userRes.user.id)
        .eq("org_id", prof.org_id)
        .eq("role", "viewer")
        .maybeSingle();
      setIsViewer(!!viewerRow);
    } else {
      setIsViewer(false);
    }

    // 열람 기록에 쓸 로그인 정보 등록(화면 어디서든 logView 를 부를 수 있게)
    setViewLogContext({
      orgId: prof.org_id,
      userId: userRes.user.id,
      userName: prof.name,
      getIp: () => runGetIp(),
    });

    // 접속 로그 — 접속할 때마다 1회(관리자 포함 전체). 화면을 기다리게 하지 않는다.
    void logAccessOncePerVisit({
      orgId: prof.org_id,
      userId: userRes.user.id,
      userName: prof.name,
      signInAt: userRes.user.last_sign_in_at ?? null,
      getIp: () => runGetIp(),
    });

    const [orgRes, cliRes, provRes, allLogs, planLinksRes] = await Promise.all([
      supabase
        .from("organizations")
        .select("id,name,org_type,client_types,join_code,slug")
        .eq("id", prof.org_id)
        .single(),
      supabase
        .from("clients")
        .select("*")
        .eq("org_id", prof.org_id)
        .order("name"),
      fetchAllProvisions(prof.org_id),
      fetchAllLogs(prof.org_id),
      fetchCarePlanActionLinks(supabase, prof.org_id),
    ]);

    if (orgRes.error) toast.error("기관 정보 로딩 실패: " + orgRes.error.message);
    if (cliRes.error) toast.error("대상자 목록 로딩 실패: " + cliRes.error.message);
    if (provRes.error) toast.error("제공이력 로딩 실패: " + provRes.error.message);

    const loadedOrg = orgRes.data as OrgRow ?? null;

    // URL slug가 내 org slug와 다르면 올바른 주소로 리다이렉트
    if (loadedOrg?.slug && loadedOrg.slug !== slug) {
      navigate({ to: "/$slug", params: { slug: loadedOrg.slug }, search: { tab: undefined }, replace: true });
      return;
    }

    setOrg(loadedOrg);
    setClients((cliRes.data as Client[]) ?? []);
    setLogs(allLogs);
    setProvisions((provRes.data as Provision[]) ?? []);
    if (planLinksRes === null) {
      toast.error("계획 연동 정보를 불러오지 못했어요. 사례관리 계획 달성률이 실제와 다르게 보일 수 있으니 새로고침해 주세요.");
    } else {
      setPlanLinks(planLinksRes);
    }
    setLogsFullyLoaded(true);
    setLoading(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "알 수 없는 오류";
      toast.error("데이터 로딩 오류: " + msg + " — 새로고침 해주세요.");
      setLoading(false);
    }
  }, [navigate, slug, runGetIp]);

  useEffect(() => {
    load();
  }, [load]);

  // 전체 상담기록 로드 (12개월 이전 기록 포함)
  const loadAllLogs = useCallback(async () => {
    if (logsFullyLoaded || !org) return;
    try {
      const allLogs = await fetchAllLogs(org.id);
      setLogs(allLogs);
      setLogsFullyLoaded(true);
      toast.success("전체 상담기록을 불러왔습니다.");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "알 수 없는 오류";
      toast.error("전체 기록 로딩 실패: " + msg);
    }
  }, [logsFullyLoaded, org]);

  // 경량 상담기록 갱신 — 엑셀 업로드 직후 사용 (페이지네이션으로 전체 로드)
  const refreshLogs = useCallback(async () => {
    if (!org) return;
    try {
      const allLogs = await fetchAllLogs(org.id);
      setLogs(allLogs);
    } catch (e: unknown) {
      console.warn("[refreshLogs]", e);
    }
  }, [org]);

  async function signOut() {
    // 로그아웃 기록(최대 1.5초만 기다림, 실패해도 로그아웃은 진행)
    if (profile?.org_id) {
      const { data: u } = await supabase.auth.getUser();
      if (u.user) await logLogout({ orgId: profile.org_id, userId: u.user.id, userName: profile.name });
    }
    setViewLogContext(null);
    clearResourceChat();
    await supabase.auth.signOut();
    navigate({ to: "/auth", search: { next: "" } });
  }

  // 기관 코드 클립보드 복사
  async function copyJoinCode() {
    const code = org?.join_code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast.success("기관 코드가 복사되었습니다.");
    } catch {
      toast.error("복사에 실패했습니다. 코드를 길게 눌러 직접 복사해주세요.");
    }
  }

  if (loading)
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        불러오는 중...
      </div>
    );

  // 관리자 미승인 — 대기 화면
  if (pendingApproval)
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-secondary/30 to-accent/20 px-4">
        <Toaster richColors position="top-center" />
        <div className="w-full max-w-md text-center bg-card border border-border rounded-2xl p-8 shadow-sm">
          <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-amber-100 flex items-center justify-center">
            <Clock className="h-7 w-7 text-amber-600" />
          </div>
          <h2 className="text-xl font-semibold mb-2">승인 대기 중</h2>
          <p className="text-sm text-muted-foreground leading-relaxed mb-5">
            기관 관리자가 아직 승인하지 않았습니다.<br />
            관리자가 <strong>기관 멤버</strong> 탭에서 승인하면<br />
            대시보드에 접근할 수 있습니다.
          </p>
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800 mb-5">
            승인 완료 후 아래 버튼으로 새로고침해 주세요.
          </div>
          <div className="flex flex-col gap-2">
            <Button onClick={() => window.location.reload()} variant="default" className="w-full">
              새로고침
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={async () => {
                clearResourceChat();
                await supabase.auth.signOut();
                navigate({ to: "/auth", search: { next: "" } });
              }}
            >
              <LogOut className="h-4 w-4 mr-1.5" />
              로그아웃
            </Button>
          </div>
        </div>
      </div>
    );

  return (
    <NameMaskProvider>
    <div className="min-h-screen bg-background">
      <Toaster richColors position="top-center" />
      <DriveViewerHost />
      <PrivacyPolicyDialog open={privacyOpen} onOpenChange={setPrivacyOpen} />
      <header className="sticky top-0 z-30 bg-background/80 backdrop-blur border-b border-border">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-2.5">
          <div className="flex items-center justify-between gap-2">
            {/* 왼쪽: 로고 + 기관명 — 클릭 시 상담탭(홈)으로 이동 + 데이터 새로고침 */}
            <button
              type="button"
              onClick={() => { handleTabChange("counsel"); load(); }}
              className="flex items-center gap-2 sm:gap-3 min-w-0 cursor-pointer hover:opacity-75 active:opacity-50 transition-opacity"
              title="홈으로 이동 · 새로고침"
            >
              <div className="h-9 w-9 shrink-0 rounded-lg bg-primary text-primary-foreground flex items-center justify-center">
                <HeartHandshake className="h-5 w-5" />
              </div>
              <div className="min-w-0 text-left">
                <div className="text-sm font-semibold leading-tight truncate">{org?.name}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                  <Building2 className="h-3 w-3 shrink-0" />
                  <span className="truncate">{org?.org_type}</span>
                  {isViewer && <span className="sm:hidden shrink-0 font-medium text-foreground">· 조회 전용</span>}
                </div>
              </div>
            </button>
            {/* 오른쪽: 담당자 + 액션 (모바일은 아이콘만) */}
            <div className="flex items-center gap-1 sm:gap-2 text-sm shrink-0">
              <span className="hidden md:inline text-muted-foreground">담당자</span>
              <span className="hidden sm:inline font-medium">{profile?.name}</span>
              {isViewer && (
                <span className="hidden sm:inline rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground" title="조회 전용 계정이에요. 입력·수정·삭제와 AI 기능은 사용할 수 없어요.">
                  조회 전용
                </span>
              )}
              <NameMaskToggle />
              <Button size="sm" variant="ghost" className="px-2 sm:px-3" onClick={() => setPrivacyOpen(true)} title="개인정보처리방침" aria-label="개인정보처리방침">
                <ShieldCheck className="h-4 w-4" />
                <span className="hidden lg:inline">개인정보처리방침</span>
              </Button>
              <Button size="sm" variant="ghost" className="px-2 sm:px-3" onClick={() => setGuideOpen(true)} title="이용 가이드">
                <HelpCircle className="h-4 w-4" />
                <span className="hidden sm:inline">가이드</span>
              </Button>
              <Button size="sm" variant="ghost" className="px-2 sm:px-3" onClick={() => setSettingsOpen(true)}>
                <Settings className="h-4 w-4" />
                <span className="hidden sm:inline">계정 설정</span>
              </Button>
              <Button size="sm" variant="ghost" className="px-2 sm:px-3" onClick={signOut}>
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">로그아웃</span>
              </Button>
            </div>
          </div>

          {/* 기관 코드: 항상 표시 · 눌러서 복사/공유 (동료 초대용) */}
          {org?.join_code && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={copyJoinCode}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-accent/40 px-2.5 py-1 text-xs hover:bg-accent active:scale-[0.98] transition"
                title="눌러서 기관 코드를 복사하세요."
              >
                <span className="text-muted-foreground font-sans">기관 코드</span>
                <span className="font-mono tracking-widest font-semibold text-foreground">
                  {org.join_code}
                </span>
                <Copy className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
              <span className="text-[11px] text-muted-foreground">눌러서 복사 → 동료 초대</span>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6">
        <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
          <div className="flex items-center gap-2">
            <TabsList className="w-auto max-w-full justify-start overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
              {tabOrder
                .filter((v) => !tabHidden.includes(v))
                .map((v) => {
                  const t = TAB_DEFS.find((x) => x.value === v);
                  if (!t) return null;
                  const Icon = t.icon;
                  return (
                    <TabsTrigger key={v} value={v} className="shrink-0">
                      <Icon className="h-4 w-4 mr-1" />
                      {t.label}
                    </TabsTrigger>
                  );
                })}
              {isAdmin && (
                <TabsTrigger value="admin" className="shrink-0">
                  <ShieldCheck className="h-4 w-4 mr-1" />
                  관리자
                </TabsTrigger>
              )}
            </TabsList>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setTabSettingsOpen(true)}
              title="사용할 탭과 순서를 설정"
              className="shrink-0"
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span className="hidden sm:inline">탭 설정</span>
            </Button>
          </div>

          <TabsContent value="counsel">
            <TabErrorBoundary tabName="상담">
              <CounselTab
                clients={clients}
                logs={logs}
                provisions={provisions}
                org={org}
                workerName={profile?.name ?? ""}
                onChanged={load}
                onLogsChanged={refreshLogs}
                logsFullyLoaded={logsFullyLoaded}
                onLoadAllLogs={loadAllLogs}
                canWrite={!isViewer}
                planLinks={planLinks}
              />
            </TabErrorBoundary>
          </TabsContent>
          <TabsContent value="clients">
            <TabErrorBoundary tabName="대상자">
              <ClientsTab
                clients={clients}
                logs={logs}
                provisions={provisions}
                org={org}
                workerName={profile?.name ?? ""}
                onChanged={load}
                focusClientId={focusClientId}
                onFocusConsumed={() => setFocusClientId(null)}
                canWrite={!isViewer}
                planLinks={planLinks}
              />
            </TabErrorBoundary>
          </TabsContent>
          <TabsContent value="servicegoals">
            <TabErrorBoundary tabName="서비스목표">
              <ServiceGoalsTab
                clients={clients}
                logs={logs}
                provisions={provisions}
                onChanged={load}
                canWrite={!isViewer}
                planLinks={planLinks}
              />
            </TabErrorBoundary>
          </TabsContent>
          <TabsContent value="members">
            <TabErrorBoundary tabName="구성원">
              {org && profile && (
                <MembersTab orgId={org.id} currentUserId={profile.id} clients={clients} onChanged={load} />
              )}
            </TabErrorBoundary>
          </TabsContent>
          <TabsContent value="manual">
            <TabErrorBoundary tabName="매뉴얼">
              <ManualTab org={org} />
            </TabErrorBoundary>
          </TabsContent>
          {isAdmin && org && (
            <TabsContent value="admin">
              <TabErrorBoundary tabName="관리자">
                <AdminTab orgId={org.id} onReverted={load} />
              </TabErrorBoundary>
            </TabsContent>
          )}
          <TabsContent value="overview">
            <TabErrorBoundary tabName="전체현황">
              <OverviewTab clients={clients} logs={logs} provisions={provisions} org={org} planLinks={planLinks} />
            </TabErrorBoundary>
          </TabsContent>
          <TabsContent value="companion">
            <TabErrorBoundary tabName="말벗모니터">
              <CompanionMonitorTab
                org={org}
                isAdmin={isAdmin}
                onGoToClient={(id) => { handleTabChange("clients"); setFocusClientId(id); }}
                workerName={profile?.name ?? ""}
              />
            </TabErrorBoundary>
          </TabsContent>
        </Tabs>
      </main>

      <TabSettingsDialog
        open={tabSettingsOpen}
        onOpenChange={setTabSettingsOpen}
        order={tabOrder}
        hidden={tabHidden}
        onSave={saveTabPrefs}
      />

      <AccountSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        currentName={profile?.name}
        onUpdated={load}
      />

      <UserGuideDialog
        open={guideOpen}
        onOpenChange={setGuideOpen}
        defaultTab={isAdmin ? "admin" : "user"}
      />
    </div>
    </NameMaskProvider>
  );
}

function TabSettingsDialog({
  open,
  onOpenChange,
  order,
  hidden,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  order: string[];
  hidden: string[];
  onSave: (order: string[], hidden: string[]) => void;
}) {
  const [draft, setDraft] = useState<string[]>(order);
  const [draftHidden, setDraftHidden] = useState<string[]>(hidden);
  useEffect(() => {
    if (open) {
      setDraft(order);
      setDraftHidden(hidden);
    }
  }, [open, order, hidden]);

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= draft.length) return;
    const next = draft.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setDraft(next);
  }
  function toggle(v: string) {
    setDraftHidden((h) => {
      if (h.includes(v)) return h.filter((x) => x !== v);
      // 최소 1개 탭은 남겨둠
      const visibleCount = draft.filter((x) => !h.includes(x)).length;
      if (visibleCount <= 1) return h;
      return [...h, v];
    });
  }

  const labelOf = (v: string) => TAB_DEFS.find((t) => t.value === v)?.label ?? v;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>탭 설정</DialogTitle>
          <DialogDescription>
            사용할 탭만 체크하고 순서를 바꿔보세요. 맨 위(표시된) 탭이 로그인 시 처음 열립니다. 복순이
            모니터링은 기본으로 숨겨져 있으니 필요하면 체크해서 켜세요. (이 기기에 저장)
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          {draft.map((v, i) => {
            const on = !draftHidden.includes(v);
            return (
              <div
                key={v}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(v)}
                  className="h-4 w-4 accent-primary cursor-pointer"
                  title={on ? "숨기기" : "표시하기"}
                />
                <span
                  className={`text-sm flex-1 ${on ? "" : "text-muted-foreground line-through"}`}
                >
                  {labelOf(v)}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  disabled={i === draft.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={() => {
              setDraft(DEFAULT_ORDER);
              setDraftHidden(DEFAULT_HIDDEN);
            }}
          >
            <RotateCcw className="h-4 w-4" />
            기본값
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button
            onClick={() => {
              onSave(draft, draftHidden);
              onOpenChange(false);
            }}
          >
            저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
