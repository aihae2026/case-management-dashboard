import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Info, ArrowRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ClientName } from "@/components/NameMask";
import { isConfiguredWorker } from "@/lib/worker-defaults";
import { isTerminated, programsOf, type Client } from "@/lib/case-types";

// ── 담당자 인수인계(관리자 전용) ─────────────────────────────────
// 이전 담당자의 대상자를 새 담당자에게 옮긴다. 바뀌는 것은 대상자의 '현재 담당'뿐이고,
// 이전 담당자가 쓴 상담기록의 작성자 이름은 그대로 남는다. 새 담당자는 이 기관에 가입·승인된 구성원만 고를 수 있다.
// 관리자 확인과 기관 확인은 화면이 아니라 DB 함수(handover_clients)가 한다.

type Member = { id: string; name: string; email: string | null };
type HandoverRow = {
  id: string;
  from_name: string;
  to_name: string;
  moved_count: number;
  performed_by_name: string | null;
  performed_at: string;
  note: string | null;
};
type Scope = "all" | "type" | "pick";

export function WorkerHandoverDialog({
  open,
  onOpenChange,
  orgId,
  clients,
  onChanged,
  initialFrom = "",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orgId: string;
  clients: Client[];
  onChanged: () => void;
  /** 멤버 표에서 열 때 이전 담당자를 미리 채워 둔다 */
  initialFrom?: string;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [history, setHistory] = useState<HandoverRow[]>([]);
  const [historyError, setHistoryError] = useState(false);

  const [fromName, setFromName] = useState("");
  const [toUserId, setToUserId] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [typeSel, setTypeSel] = useState<Set<string>>(new Set());
  const [pickSel, setPickSel] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // 이전 담당자 후보: 지금 대상자에 배정된 이름(대상자 수와 함께)
  const fromOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of clients) {
      const n = (c.worker_name ?? "").trim();
      if (n) m.set(n, (m.get(n) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], "ko"));
  }, [clients]);

  const fromClients = useMemo(
    () => (fromName ? clients.filter((c) => (c.worker_name ?? "").trim() === fromName) : []),
    [clients, fromName],
  );
  // 구분은 "사례관리,무료급식"처럼 여러 사업이 한 값에 들어 있을 수 있어, 다른 화면과 같은 방식(programsOf)으로 사업별로 나눈다.
  // 두 사업에 걸친 대상자는 각 사업 수에 모두 들어가므로 합계가 전체보다 클 수 있다.
  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of fromClients) for (const p of programsOf(c)) m.set(p, (m.get(p) ?? 0) + 1);
    return [...m.entries()];
  }, [fromClients]);

  const targetIds = useMemo(() => {
    if (scope === "all") return fromClients.map((c) => c.id);
    if (scope === "type") return fromClients.filter((c) => programsOf(c).some((p) => typeSel.has(p))).map((c) => c.id);
    return fromClients.filter((c) => pickSel.has(c.id)).map((c) => c.id);
  }, [scope, fromClients, typeSel, pickSel]);

  const candidates = useMemo(() => members.filter((m) => m.name !== fromName), [members, fromName]);
  const toMember = members.find((m) => m.id === toUserId) ?? null;

  const loadMembers = useCallback(async () => {
    setMembersLoading(true);
    const [{ data: profs }, { data: roles }] = await Promise.all([
      supabase.from("profiles").select("id,name,email").eq("org_id", orgId).eq("status", "approved"),
      supabase.from("user_roles").select("user_id,role").eq("org_id", orgId),
    ]);
    // 읽기 전용(뷰어) 계정은 담당자가 될 수 없다(서버도 같은 규칙으로 막는다)
    const viewers = new Set((roles ?? []).filter((r) => r.role === "viewer").map((r) => r.user_id));
    setMembers(
      (profs ?? [])
        .filter((p) => (p.name ?? "").trim() && !viewers.has(p.id))
        .map((p) => ({ id: p.id, name: (p.name ?? "").trim(), email: p.email }))
        .sort((a, b) => a.name.localeCompare(b.name, "ko")),
    );
    setMembersLoading(false);
  }, [orgId]);

  const loadHistory = useCallback(async () => {
    const { data, error } = await supabase
      .from("worker_handovers")
      .select("id,from_name,to_name,moved_count,performed_by_name,performed_at,note")
      .eq("org_id", orgId)
      .order("performed_at", { ascending: false })
      .limit(10);
    setHistoryError(!!error);
    setHistory(error ? [] : (data ?? []));
  }, [orgId]);

  useEffect(() => {
    if (!open) return;
    setFromName(initialFrom.trim());
    setToUserId("");
    setNote("");
    void loadMembers();
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loadMembers, loadHistory]);

  // 이전 담당자를 바꾸면 범위 선택을 처음 상태로
  useEffect(() => {
    setScope("all");
    setPickSel(new Set());
    setTypeSel(new Set(typeCounts.map(([t]) => t)));
    setToUserId((id) => (members.find((m) => m.id === id)?.name === fromName ? "" : id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromName]);

  async function submit() {
    if (!fromName || !toMember || targetIds.length === 0 || busy) return;
    if (
      !confirm(
        `'${fromName}' 담당 대상자 ${targetIds.length}명을 '${toMember.name}' 님에게 넘길까요?\n\n` +
          `이전 담당자가 쓴 상담기록의 작성자 이름은 그대로 남아요.`,
      )
    )
      return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("handover_clients", {
        p_from: fromName,
        p_to_user: toMember.id,
        p_client_ids: targetIds,
        p_note: note.trim() || undefined,
      });
      if (error) {
        throw new Error(
          /Could not find the function/.test(error.message)
            ? "인수인계 기능이 아직 이 서비스의 데이터베이스에 적용되지 않았어요. 운영 담당자에게 문의해 주세요."
            : error.message,
        );
      }
      const r = data as { moved?: number; skipped?: number; to_name?: string } | null;
      toast.success(
        `${r?.moved ?? targetIds.length}명을 '${fromName}' → '${r?.to_name ?? toMember.name}' 님에게 넘겼어요.` +
          (r?.skipped ? ` (이미 담당이 바뀐 ${r.skipped}명은 건너뛰었어요)` : ""),
      );
      setPickSel(new Set());
      setNote("");
      onChanged();
      void loadHistory();
    } catch (e) {
      toast.error("인수인계 실패: " + ((e as Error).message || "알 수 없는 오류"));
    }
    setBusy(false);
  }

  const toggle = (set: Set<string>, id: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[88dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>담당자 인수인계</DialogTitle>
          <DialogDescription>
            이전 담당자의 대상자를 새 담당자에게 넘겨요. 이전 담당자가 쓴 상담기록의 작성자 이름은 그대로 남아요.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {/* 1. 이전 담당자 */}
          <section className="space-y-1.5">
            <h4 className="text-xs font-medium text-muted-foreground">1. 이전 담당자</h4>
            <Select value={fromName || undefined} onValueChange={setFromName}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="넘기는 사람을 고르세요" />
              </SelectTrigger>
              <SelectContent>
                {fromOptions.map(([name, n]) => (
                  <SelectItem key={name} value={name}>
                    {name} · 대상자 {n}명
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>

          {/* 2. 새 담당자 */}
          <section className="space-y-1.5">
            <h4 className="text-xs font-medium text-muted-foreground">2. 새 담당자 (이 기관에 가입·승인된 구성원만)</h4>
            <Select value={toUserId || undefined} onValueChange={setToUserId} disabled={!fromName || membersLoading}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder={membersLoading ? "구성원을 불러오는 중…" : "받는 사람을 고르세요"} />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                    {m.email ? ` (${m.email})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground flex gap-1">
              <Info className="h-3.5 w-3.5 shrink-0 mt-px" />
              목록에 없으면 새 담당자가 먼저 본인의 구글 계정으로 가입하고, 관리자가 구성원 탭에서 승인해야 해요. 가입과 승인이 끝난 뒤에 인수인계를 진행하세요.
            </p>
          </section>

          {/* 3. 대상자 범위 */}
          <section className="space-y-1.5">
            <h4 className="text-xs font-medium text-muted-foreground">3. 넘길 대상자</h4>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["all", `전체 (${fromClients.length}명)`],
                  ["type", "구분별"],
                  ["pick", "직접 고르기"],
                ] as [Scope, string][]
              ).map(([v, label]) => (
                <Button
                  key={v}
                  type="button"
                  size="sm"
                  variant={scope === v ? "default" : "outline"}
                  disabled={!fromName}
                  onClick={() => setScope(v)}
                >
                  {label}
                </Button>
              ))}
            </div>

            {scope === "type" && (
              <div className="space-y-1 rounded-md border border-border p-2">
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {typeCounts.map(([t, n]) => (
                    <label key={t} className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <Checkbox checked={typeSel.has(t)} onCheckedChange={() => toggle(typeSel, t, setTypeSel)} />
                      {t} <span className="text-muted-foreground">{n}명</span>
                    </label>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  여러 사업에 걸친 대상자는 어느 사업을 골라도 포함돼요. 종결 대상자도 담당이 있으면 포함돼요.
                </p>
              </div>
            )}

            {scope === "pick" && (
              <div className="rounded-md border border-border">
                <div className="flex items-center justify-between px-2 py-1 border-b border-border text-[11px] text-muted-foreground">
                  <span>{pickSel.size}명 선택</span>
                  <button
                    type="button"
                    className="underline hover:text-foreground"
                    onClick={() =>
                      setPickSel(pickSel.size === fromClients.length ? new Set() : new Set(fromClients.map((c) => c.id)))
                    }
                  >
                    {pickSel.size === fromClients.length ? "모두 해제" : "모두 선택"}
                  </button>
                </div>
                <div className="max-h-48 overflow-y-auto divide-y divide-border">
                  {fromClients.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-muted/50">
                      <Checkbox checked={pickSel.has(c.id)} onCheckedChange={() => toggle(pickSel, c.id, setPickSel)} />
                      <span className="font-medium">
                        <ClientName c={c} />
                      </span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {programsOf(c).join("·")}
                      </Badge>
                      {isTerminated(c) && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-zinc-100 text-zinc-700">
                          종결
                        </Badge>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* 4. 메모 */}
          <section className="space-y-1.5">
            <h4 className="text-xs font-medium text-muted-foreground">메모 (선택)</h4>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={200}
              placeholder="예: 2026년 11월 사업 개편으로 담당 변경"
              className="h-9"
            />
          </section>

          {/* 미리보기 */}
          {fromName && toMember && (
            <div className="rounded-md bg-muted/60 px-3 py-2 flex items-center gap-2 flex-wrap">
              <span className="font-medium">{fromName}</span>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{toMember.name}</span>
              <span className="text-muted-foreground">· 대상자 {targetIds.length}명</span>
            </div>
          )}

          {fromName && isConfiguredWorker(fromName) && (
            <p className="text-[11px] text-amber-700 flex gap-1">
              <Info className="h-3.5 w-3.5 shrink-0 mt-px" />
              '{fromName}' 이름이 담당자 명단·사업별 기본 담당자 설정(Vercel 환경변수 VITE_DEFAULT_WORKER_CONFIG)에도 들어 있어요. 엑셀 일괄 등록의 기본 담당자가 이전 담당자로 들어가니, 설정도 함께 고쳐 주세요.
            </p>
          )}

          {/* 최근 인수인계 */}
          <section className="space-y-1">
            <h4 className="text-xs font-medium text-muted-foreground">최근 인수인계</h4>
            {historyError ? (
              <p className="text-[11px] text-muted-foreground">이력을 불러오지 못했어요. 인수인계 기능이 아직 적용되지 않았을 수 있어요.</p>
            ) : history.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">아직 인수인계 기록이 없어요.</p>
            ) : (
              <ul className="space-y-0.5">
                {history.map((h) => (
                  <li key={h.id} className="text-xs">
                    {new Date(h.performed_at).toLocaleDateString("ko-KR")} · {h.from_name} → {h.to_name} · {h.moved_count}명
                    <span className="text-muted-foreground">
                      {h.performed_by_name ? ` (처리: ${h.performed_by_name})` : ""}
                      {h.note ? ` · ${h.note}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
          <Button onClick={submit} disabled={busy || !fromName || !toMember || targetIds.length === 0}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            인수인계 ({targetIds.length}명)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
