import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { RotateCcw, LogIn, History, Loader2, RefreshCw, ImageUp, CheckCircle2, AlertCircle, Eye } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useNameMask } from "@/lib/name-mask-context";

type Json = Record<string, unknown> | null;
type AuditRow = {
  id: string;
  table_name: string;
  row_id: string | null;
  op: string;
  old_data: Json;
  new_data: Json;
  actor_name: string | null;
  created_at: string;
  reverted_at: string | null;
  reverted_by_name: string | null;
};
type AccessRow = {
  id: string;
  user_name: string | null;
  action: string;
  device: string | null;
  ip?: string | null;
  created_at: string;
};
type ViewRow = {
  id: string;
  user_name: string | null;
  client_id: string | null;
  client_code: string | null;
  action: string;
  detail: string | null;
  device: string | null;
  ip: string | null;
  created_at: string;
};
const PERIODS = [
  { v: "1", label: "오늘" },
  { v: "7", label: "최근 7일" },
  { v: "30", label: "최근 30일" },
  { v: "all", label: "전체" },
];
const LIST_LIMIT = 500; // 접속 이력·열람 기록
const AUDIT_LIMIT = 300; // 변경 히스토리(수정 전·후 내용이 커서 더 적게)
/** 기간("1"=오늘, "7"=최근 7일 …)의 시작 시각(ISO). "all"이면 null */
const sinceOf = (period: string): string | null => {
  if (period === "all") return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (Number(period) - 1));
  return d.toISOString();
};

const TABLE_LABEL: Record<string, string> = {
  clients: "대상자",
  activity_logs: "상담기록",
  provisions: "제공이력",
  goals: "목표",
};
const OP_LABEL: Record<string, string> = { INSERT: "추가", UPDATE: "수정", DELETE: "삭제" };
const OP_STYLE: Record<string, string> = {
  INSERT: "bg-emerald-50 text-emerald-700 border-emerald-200",
  UPDATE: "bg-amber-50 text-amber-700 border-amber-200",
  DELETE: "bg-red-50 text-red-700 border-red-200",
};
const FIELD_LABEL: Record<string, string> = {
  name: "이름",
  phone: "전화",
  address: "주소",
  gender: "성별",
  birth: "생년월일",
  note: "비고",
  needs: "욕구",
  grade: "구분",
  risk: "위험도",
  welfare_status: "대상구분",
  worker_name: "담당자",
  progress: "달성률",
  summary: "요약",
  method: "방법",
  title: "제목",
  detail: "내용",
  category: "분류",
  genogram: "가계도",
};

function rowName(r: AuditRow): string {
  const d = (r.new_data ?? r.old_data ?? {}) as Record<string, unknown>;
  return (d.name as string) ?? (d.title as string) ?? (r.row_id ? r.row_id.slice(0, 8) : "-");
}
function changedFields(r: AuditRow): string[] {
  if (r.op !== "UPDATE" || !r.old_data || !r.new_data) return [];
  const o = r.old_data as Record<string, unknown>;
  const n = r.new_data as Record<string, unknown>;
  const skip = new Set(["updated_at", "created_at"]);
  const out: string[] = [];
  for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
    if (skip.has(k)) continue;
    if (JSON.stringify(o[k]) !== JSON.stringify(n[k])) out.push(FIELD_LABEL[k] ?? k);
  }
  return out;
}
const fmt = (iso: string) => new Date(iso).toLocaleString("ko-KR");

export function AdminTab({ orgId, onReverted }: { orgId: string; onReverted: () => void }) {
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [access, setAccess] = useState<AccessRow[]>([]);
  const [auditReady, setAuditReady] = useState(false);
  const [accessReady, setAccessReady] = useState(false);
  const loading = !auditReady || !accessReady; // 처음 한 번만 전체 화면 로딩, 이후 필터를 바꿀 때는 목록만 갱신
  const [err, setErr] = useState<string | null>(null);
  const [opFilter, setOpFilter] = useState("전체");
  const [tableFilter, setTableFilter] = useState("전체");
  const [busyId, setBusyId] = useState<string | null>(null);

  // 접속 이력·변경 히스토리: 기본은 최근 7일
  const [accessPeriod, setAccessPeriod] = useState("7");
  const [accessUser, setAccessUser] = useState("전체");
  const [auditPeriod, setAuditPeriod] = useState("7");
  const [auditUser, setAuditUser] = useState("전체");

  // 열람 기록
  const { hidden: namesHidden } = useNameMask();
  const [views, setViews] = useState<ViewRow[]>([]);
  const [viewErr, setViewErr] = useState<string | null>(null);
  const [viewPeriod, setViewPeriod] = useState("7");
  const [viewUser, setViewUser] = useState("전체");
  const [viewAction, setViewAction] = useState("전체");
  const [viewQ, setViewQ] = useState("");
  const [clientMap, setClientMap] = useState<Map<string, { name: string; code: string | null }>>(new Map());

  // 가계도 Drive 일괄 백업 상태
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupProgress, setBackupProgress] = useState<{ done: number; total: number } | null>(null);
  const [backupResult, setBackupResult] = useState<{ ok: string[]; fail: string[] } | null>(null);

  async function runGenogramBackup() {
    if (!confirm("DB에 저장된 가계도(data URI)를 모두 Google Drive로 이관합니다.\n완료 후 DB는 Drive URL로 교체됩니다. 계속할까요?")) return;
    setBackupRunning(true);
    setBackupProgress(null);
    setBackupResult(null);

    try {
      // 1) 해당 기관 가계도 보유 대상자 조회
      //    genogram 컬럼은 DB에 있지만 Supabase 자동생성 타입에 미반영 → .returns<T>()로 반환 타입만 오버라이드
      type GenogramClient = { id: string; name: string; client_code: string | null; genogram: string | null };
      const clientsRes = await supabase
        .from("clients")
        .select("id, name, client_code, genogram")
        .eq("org_id", orgId)
        .not("genogram", "is", null)
        .returns<GenogramClient[]>();
      if (clientsRes.error) throw new Error("대상자 조회 실패: " + clientsRes.error.message);

      // 2) data URI인 항목만 추려냄
      const targets = (clientsRes.data ?? []).filter(
        (c): c is GenogramClient & { genogram: string } =>
          typeof c.genogram === "string" && c.genogram.startsWith("data:image/"),
      );

      if (targets.length === 0) {
        setBackupResult({ ok: [], fail: [] });
        toast.info("이관할 가계도(data URI)가 없습니다. 이미 모두 Drive에 저장돼 있어요.");
        setBackupRunning(false);
        return;
      }

      setBackupProgress({ done: 0, total: targets.length });
      const ok: string[] = [];
      const fail: string[] = [];

      for (const c of targets) {
        try {
          const base64 = c.genogram.split(",")[1];
          const dateStr = new Date().toISOString().slice(0, 10);
          // 파일명에는 이름 대신 대상자 번호를 쓴다(없으면 id 앞자리)
          const safeName = (c.client_code ?? c.id.slice(0, 8)).replace(/[/\\?%*:|"<>]/g, "").trim();

          const driveRes = await supabase.functions.invoke("drive-proxy", {
            body: {
              name: `${safeName}_가계도_${dateStr}.png`,
              mimeType: "image/png",
              data: base64,
              clientId: c.id,
              folderName: "가계도",
            },
          });
          const driveData = driveRes.data as { id?: string; error?: string } | null;

          if (!driveRes.error && driveData?.id) {
            const driveUrl = `https://drive.google.com/thumbnail?id=${driveData.id}&sz=w1600`;
            const { error: upErr } = await supabase
              .from("clients")
              .update({ genogram: driveUrl } as never)
              .eq("id", c.id);
            if (upErr) {
              fail.push(`${c.name} (DB 업데이트 실패)`);
            } else {
              ok.push(c.name);
            }
          } else {
            fail.push(`${c.name} (Drive 업로드 실패: ${driveData?.error ?? "알 수 없음"})`);
          }
        } catch (e) {
          fail.push(`${c.name} (오류: ${(e as Error).message})`);
        }
        setBackupProgress((p) => p ? { ...p, done: p.done + 1 } : null);
      }

      setBackupResult({ ok, fail });
      if (fail.length === 0) {
        toast.success(`가계도 ${ok.length}개 Drive 이관 완료!`);
      } else {
        toast.warning(`완료: 성공 ${ok.length}개 / 실패 ${fail.length}개`);
      }
    } catch (e) {
      toast.error("백업 중 오류: " + (e as Error).message);
    } finally {
      setBackupRunning(false);
    }
  }

  // 접속 이력: 기간은 서버에서 거르고(최대 500건), 직원은 불러온 기록 안에서 거른다.
  // IP 칸이 아직 DB에 없으면 IP 없이 다시 읽는다.
  const loadAccessLog = useCallback(async () => {
    const since = sinceOf(accessPeriod);
    const q = (cols: string) => {
      let b = supabase
        .from("access_log")
        .select(cols)
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(LIST_LIMIT);
      if (since) b = b.gte("created_at", since);
      return b;
    };
    try {
      const withIp = await q("id,user_name,action,device,ip,created_at");
      const res = withIp.error ? await q("id,user_name,action,device,created_at") : withIp;
      setAccess((res.data as unknown as AccessRow[]) ?? []);
    } catch (e) {
      console.warn("[admin] 접속 이력 조회 실패:", e);
    } finally {
      setAccessReady(true);
    }
  }, [orgId, accessPeriod]);

  // 변경 히스토리: 수정 전·후 내용이 커서 최근 300건까지만 가져온다.
  const loadAudit = useCallback(async () => {
    const since = sinceOf(auditPeriod);
    let q = supabase
      .from("audit_log")
      .select(
        "id,table_name,row_id,op,old_data,new_data,actor_name,created_at,reverted_at,reverted_by_name",
      )
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(AUDIT_LIMIT);
    if (since) q = q.gte("created_at", since);
    try {
      const { data, error } = await q;
      if (error) {
        setErr(error.message);
      } else {
        setErr(null);
        setAudit((data as AuditRow[]) ?? []);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "알 수 없는 오류");
    } finally {
      setAuditReady(true);
    }
  }, [orgId, auditPeriod]);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  useEffect(() => {
    void loadAccessLog();
  }, [loadAccessLog]);

  // 열람 기록(기간은 서버에서 거르고, 직원·행동·대상자 검색은 불러온 500건 안에서 거른다)
  const loadViews = useCallback(async () => {
    const since = sinceOf(viewPeriod);
    let q = supabase
      .from("view_log")
      .select("id,user_name,client_id,client_code,action,detail,device,ip,created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT);
    if (since) q = q.gte("created_at", since);
    const { data, error } = await q;
    if (error) {
      setViewErr(error.message);
      setViews([]);
      return;
    }
    setViewErr(null);
    setViews((data ?? []) as ViewRow[]);
  }, [orgId, viewPeriod]);

  useEffect(() => {
    void loadViews();
  }, [loadViews]);

  // 전체 다시 불러오기(되돌린 뒤, 새로고침 버튼): 접속 이력·열람 기록·변경 히스토리 모두
  const load = useCallback(async () => {
    await Promise.all([loadAudit(), loadAccessLog(), loadViews()]);
  }, [loadAudit, loadAccessLog, loadViews]);

  useEffect(() => {
    supabase
      .from("clients")
      .select("id,name,client_code")
      .eq("org_id", orgId)
      .then(({ data }) => {
        const m = new Map<string, { name: string; code: string | null }>();
        (data ?? []).forEach((c) => m.set(c.id, { name: c.name, code: c.client_code }));
        setClientMap(m);
      });
  }, [orgId]);

  const viewUsers = useMemo(
    () => ["전체", ...Array.from(new Set(views.map((v) => v.user_name ?? "알 수 없음")))],
    [views],
  );
  const viewActions = useMemo(() => ["전체", ...Array.from(new Set(views.map((v) => v.action)))], [views]);
  const viewRows = useMemo(() => {
    const kw = viewQ.trim().toLowerCase();
    return views.filter((v) => {
      if (viewUser !== "전체" && (v.user_name ?? "알 수 없음") !== viewUser) return false;
      if (viewAction !== "전체" && v.action !== viewAction) return false;
      if (kw) {
        const info = v.client_id ? clientMap.get(v.client_id) : undefined;
        const hay = `${v.client_code ?? info?.code ?? ""} ${info?.name ?? ""}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [views, viewUser, viewAction, viewQ, clientMap]);

  async function revert(r: AuditRow) {
    const what = `${TABLE_LABEL[r.table_name] ?? r.table_name} '${rowName(r)}' ${OP_LABEL[r.op] ?? r.op}`;
    if (!confirm(`다음 변경을 되돌립니다:\n\n${what}\n\n계속할까요?`)) return;
    setBusyId(r.id);
    const { error } = await supabase.rpc("revert_audit", { _audit_id: r.id });
    setBusyId(null);
    if (error) return toast.error("되돌리기 실패: " + error.message);
    toast.success("되돌렸습니다.");
    await load();
    onReverted();
  }

  const rows = useMemo(
    () =>
      audit.filter(
        (r) =>
          (opFilter === "전체" || r.op === opFilter) &&
          (tableFilter === "전체" || r.table_name === tableFilter) &&
          (auditUser === "전체" || (r.actor_name ?? "알 수 없음") === auditUser),
      ),
    [audit, opFilter, tableFilter, auditUser],
  );
  const auditUsers = useMemo(
    () => ["전체", ...Array.from(new Set(audit.map((r) => r.actor_name ?? "알 수 없음")))],
    [audit],
  );
  const accessUsers = useMemo(
    () => ["전체", ...Array.from(new Set(access.map((a) => a.user_name ?? "알 수 없음")))],
    [access],
  );
  const accessRows = useMemo(
    () => access.filter((a) => accessUser === "전체" || (a.user_name ?? "알 수 없음") === accessUser),
    [access, accessUser],
  );

  if (loading)
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
        불러오는 중...
      </div>
    );

  if (err)
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        감사 로그를 불러올 수 없습니다. DB에 감사 기능이 아직 반영되지 않았거나 권한이 없습니다.
        <div className="mt-2 text-xs">{err}</div>
        <Button size="sm" variant="outline" className="mt-3" onClick={load}>
          <RefreshCw className="h-4 w-4" /> 다시 시도
        </Button>
      </div>
    );

  return (
    <div className="space-y-6">
      {/* 가계도 Drive 일괄 백업 */}
      <section>
        <div className="flex items-center gap-1.5 text-sm font-semibold mb-2">
          <ImageUp className="h-4 w-4" /> 가계도 Drive 일괄 백업
        </div>
        <div className="rounded-lg border border-border p-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            DB에 직접 저장된 가계도(data URI)를 Google Drive &gt; <strong>가계도</strong> 폴더로 이관합니다.
            이관 후 DB에는 Drive URL만 남아 용량이 크게 줄어듭니다.
          </p>

          {/* 진행 상황 */}
          {backupProgress && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>업로드 중…</span>
                <span>{backupProgress.done} / {backupProgress.total}</span>
              </div>
              <div className="h-2 rounded-full bg-border overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${(backupProgress.done / backupProgress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* 결과 */}
          {backupResult && (
            <div className="space-y-1 text-xs">
              {backupResult.ok.length > 0 && (
                <div className="flex items-start gap-1.5 text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>성공 {backupResult.ok.length}명: {backupResult.ok.join(", ")}</span>
                </div>
              )}
              {backupResult.fail.length > 0 && (
                <div className="flex items-start gap-1.5 text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>실패 {backupResult.fail.length}건: {backupResult.fail.join(", ")}</span>
                </div>
              )}
              {backupResult.ok.length === 0 && backupResult.fail.length === 0 && (
                <p className="text-muted-foreground">이관할 가계도(data URI)가 없습니다.</p>
              )}
            </div>
          )}

          <Button
            size="sm"
            variant="outline"
            disabled={backupRunning}
            onClick={runGenogramBackup}
          >
            {backupRunning ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> 이관 중…</>
            ) : (
              <><ImageUp className="h-4 w-4" /> 가계도 Drive 이관 시작</>
            )}
          </Button>
        </div>
      </section>

      {/* 접속 이력 */}
      <section>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <LogIn className="h-4 w-4" /> 접속 이력
            <span className="text-xs font-normal text-muted-foreground">({accessRows.length}건)</span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Select
              value={accessPeriod}
              onValueChange={(v) => {
                setAccessPeriod(v);
                setAccessUser("전체");
              }}
            >
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIODS.map((p) => (
                  <SelectItem key={p.v} value={p.v}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={accessUser} onValueChange={setAccessUser}>
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accessUsers.map((u) => (
                  <SelectItem key={u} value={u}>
                    {u === "전체" ? "전체 직원" : u}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="rounded-lg border border-border divide-y divide-border max-h-72 overflow-y-auto">
          {accessRows.length === 0 && (
            <div className="p-3 text-sm text-muted-foreground text-center">접속 기록이 없습니다.</div>
          )}
          {accessRows.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-x-3 px-3 py-2 text-sm">
              <span className="font-medium">
                {a.user_name ?? "알 수 없음"}
                {a.action === "로그아웃" && (
                  <Badge variant="outline" className="ml-2 text-[10px] px-1.5 py-0 font-normal">로그아웃</Badge>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {fmt(a.created_at)}
                {a.device && <> · {a.device}</>}
                {a.ip && <> · {a.ip}</>}
              </span>
            </div>
          ))}
        </div>
        {access.length >= LIST_LIMIT && (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            기간 안의 기록이 많아 최근 {LIST_LIMIT}건만 보여요. 기간을 줄이면 더 정확히 볼 수 있어요.
          </p>
        )}
      </section>

      {/* 열람 기록 */}
      <section>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <Eye className="h-4 w-4" /> 열람 기록
            <span className="text-xs font-normal text-muted-foreground">({viewRows.length}건)</span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Select
              value={viewPeriod}
              onValueChange={(v) => {
                setViewPeriod(v);
                setViewUser("전체");
              }}
            >
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIODS.map((p) => (
                  <SelectItem key={p.v} value={p.v}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={viewUser} onValueChange={setViewUser}>
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {viewUsers.map((u) => (
                  <SelectItem key={u} value={u}>
                    {u === "전체" ? "전체 직원" : u}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={viewAction} onValueChange={setViewAction}>
              <SelectTrigger className="h-8 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {viewActions.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a === "전체" ? "전체 행동" : a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={viewQ}
              onChange={(e) => setViewQ(e.target.value)}
              placeholder="대상자 번호·이름"
              className="h-8 w-36"
            />
          </div>
        </div>
        <div className="rounded-lg border border-border divide-y divide-border max-h-80 overflow-y-auto">
          {viewErr && (
            <div className="p-3 text-sm text-muted-foreground text-center">
              열람 기록을 불러올 수 없습니다. DB에 열람 기록 기능이 아직 반영되지 않았을 수 있습니다.
              <div className="mt-1 text-xs">{viewErr}</div>
            </div>
          )}
          {!viewErr && viewRows.length === 0 && (
            <div className="p-3 text-sm text-muted-foreground text-center">열람 기록이 없습니다.</div>
          )}
          {viewRows.map((v) => {
            const info = v.client_id ? clientMap.get(v.client_id) : undefined;
            const code = v.client_code ?? info?.code ?? null;
            const who = v.client_id
              ? namesHidden
                ? (code ?? "대상자")
                : info
                  ? `${info.name}${code ? ` (${code})` : ""}`
                  : `${code ?? "대상자"} · 삭제된 대상자`
              : null;
            return (
              <div key={v.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{v.user_name ?? "알 수 없음"}</span>
                  <Badge variant="outline" className="ml-2 text-[10px] px-1.5 py-0 font-normal">
                    {v.action}
                  </Badge>
                  {(who || v.detail) && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {who}
                      {who && v.detail ? " · " : ""}
                      {v.detail}
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {fmt(v.created_at)}
                  {v.device && <> · {v.device}</>}
                  {v.ip && <> · {v.ip}</>}
                </span>
              </div>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          화면에서 대상자 상세를 열거나 인쇄·동의서·파일·녹음을 열 때 기록됩니다. 같은 사람이 같은 대상자를 5분 안에
          반복해서 열면 한 번만 남고, 이 기록은 수정·삭제할 수 없습니다.
          {views.length >= LIST_LIMIT && ` 기간 안의 기록이 많아 최근 ${LIST_LIMIT}건만 보여요.`}
        </p>
      </section>

      {/* 변경 히스토리 */}
      <section>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <History className="h-4 w-4" /> 변경 히스토리
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Select
              value={auditPeriod}
              onValueChange={(v) => {
                setAuditPeriod(v);
                setAuditUser("전체");
              }}
            >
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIODS.map((p) => (
                  <SelectItem key={p.v} value={p.v}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={auditUser} onValueChange={setAuditUser}>
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {auditUsers.map((u) => (
                  <SelectItem key={u} value={u}>
                    {u === "전체" ? "전체 직원" : u}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={tableFilter} onValueChange={setTableFilter}>
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="전체">전체 항목</SelectItem>
                {Object.entries(TABLE_LABEL).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={opFilter} onValueChange={setOpFilter}>
              <SelectTrigger className="h-8 w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="전체">전체 작업</SelectItem>
                <SelectItem value="INSERT">추가</SelectItem>
                <SelectItem value="UPDATE">수정</SelectItem>
                <SelectItem value="DELETE">삭제</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="h-8" onClick={load}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
          {rows.length === 0 && (
            <div className="rounded-lg border border-border p-6 text-sm text-muted-foreground text-center">
              변경 기록이 없습니다.
            </div>
          )}
          {rows.map((r) => {
            const fields = changedFields(r);
            return (
              <div
                key={r.id}
                className={`flex items-start justify-between gap-3 rounded-md border border-border p-2.5 ${r.reverted_at ? "opacity-60" : ""}`}
              >
                <div className="min-w-0 text-sm">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge variant="outline" className={OP_STYLE[r.op] ?? ""}>
                      {OP_LABEL[r.op] ?? r.op}
                    </Badge>
                    <span className="text-muted-foreground">{TABLE_LABEL[r.table_name] ?? r.table_name}</span>
                    <span className="font-medium truncate">{rowName(r)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {r.actor_name ?? "알 수 없음"} · {fmt(r.created_at)}
                    {fields.length > 0 && <> · 변경: {fields.join(", ")}</>}
                  </div>
                  {r.reverted_at && (
                    <div className="text-[11px] text-emerald-700 mt-0.5">
                      ↩ 되돌림 · {r.reverted_by_name ?? "-"} · {fmt(r.reverted_at)}
                    </div>
                  )}
                </div>
                {!r.reverted_at && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    disabled={busyId === r.id}
                    onClick={() => revert(r)}
                    title="이 변경을 되돌리기 (삭제 복구·수정 취소·추가 취소)"
                  >
                    {busyId === r.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4" />
                    )}
                    되돌리기
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        {audit.length >= AUDIT_LIMIT && (
          <p className="text-[11px] text-muted-foreground mt-2">
            기간 안의 기록이 많아 최근 {AUDIT_LIMIT}건만 보여요. 기간을 줄이면 더 정확히 볼 수 있어요.
          </p>
        )}
        <p className="text-[11px] text-muted-foreground mt-2">
          ※ 삭제 복구 시, 상위 항목(대상자)을 먼저 되돌린 뒤 하위(상담·제공·목표)를 되돌리세요.
        </p>
      </section>
    </div>
  );
}
