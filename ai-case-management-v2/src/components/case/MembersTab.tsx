import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { UserMinus, ShieldCheck, User as UserIcon, UserCheck, UserX, Clock, Pencil, Check, X, ArrowRightLeft, UserCog, AlertTriangle } from "lucide-react";
import { WorkerHandoverDialog } from "./WorkerHandoverDialog";
import { WorkerManageDialog } from "./WorkerManageDialog";
import { workerRoster, type Client } from "@/lib/case-types";

type Role = "admin" | "member" | "viewer";
type Member = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  created_at: string;
  role: Role;
};
type PendingMember = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  created_at: string;
};

export function MembersTab({
  orgId,
  currentUserId,
  clients,
  onChanged,
}: {
  orgId: string;
  currentUserId: string;
  /** 담당 대상자 수 표시와 인수인계에 쓴다 */
  clients: Client[];
  /** 담당자가 바뀐 뒤 대상자 목록을 다시 불러온다 */
  onChanged: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [pendingMembers, setPendingMembers] = useState<PendingMember[]>([]);
  const [myRole, setMyRole] = useState<Role>("member");
  const [loading, setLoading] = useState(true);
  // 연락처 인라인 편집 상태 (관리자)
  const [editingPhone, setEditingPhone] = useState<{ id: string; value: string } | null>(null);
  const [savingPhone, setSavingPhone] = useState(false);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  // 담당자 인수인계·이름 변경 대화상자 (관리자 전용)
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [handoverFrom, setHandoverFrom] = useState("");
  const [manageOpen, setManageOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: profsRaw }, { data: pendingProfsRaw }, { data: roles }] = await Promise.all([
      supabase
        .from("profiles")
        .select("id,name,email,phone,created_at")
        .eq("org_id", orgId)
        .neq("status", "pending")
        .order("created_at"),
      supabase
        .from("profiles")
        .select("id,name,email,phone,created_at")
        .eq("org_id", orgId)
        .eq("status", "pending")
        .order("created_at"),
      supabase.from("user_roles").select("user_id,role").eq("org_id", orgId),
    ]);
    type RawProfile = { id: string; name: string; email: string | null; phone?: string | null; created_at: string };
    const profs = profsRaw as unknown as RawProfile[] | null;
    const pendingProfs = pendingProfsRaw as unknown as RawProfile[] | null;
    const roleMap = new Map<string, Role>();
    const rolePriority: Record<Role, number> = { admin: 3, member: 2, viewer: 1 };
    (roles ?? []).forEach((r: { user_id: string; role: Role }) => {
      const prev = roleMap.get(r.user_id);
      if (!prev || rolePriority[r.role] > rolePriority[prev]) roleMap.set(r.user_id, r.role);
    });
    const list: Member[] = (profs ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      phone: p.phone ?? null,
      created_at: p.created_at,
      role: roleMap.get(p.id) ?? "member",
    }));
    setMembers(list);
    setPendingMembers(
      (pendingProfs ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        phone: p.phone ?? null,
        created_at: p.created_at,
      })),
    );
    setMyRole(roleMap.get(currentUserId) ?? "member");
    setLoading(false);
  }, [orgId, currentUserId]);

  useEffect(() => {
    load();
  }, [load]);

  const isAdmin = myRole === "admin";
  const adminCount = members.filter((m) => m.role === "admin").length;

  async function savePhone(memberId: string, phone: string) {
    setSavingPhone(true);
    const { error } = await supabase
      .from("profiles")
      .update({ phone: phone.trim() || null })
      .eq("id", memberId);
    setSavingPhone(false);
    if (error) return toast.error("저장 실패: " + error.message);
    setEditingPhone(null);
    toast.success("연락처가 저장되었습니다.");
    load();
  }

  async function changeRole(m: Member, next: Role) {
    if (m.role === next) return;
    if (m.role === "admin" && next !== "admin" && adminCount <= 1) {
      toast.error("기관에 관리자가 최소 1명은 있어야 합니다.");
      return;
    }
    // 기존 역할 전체 삭제 후 새 역할 삽입
    await supabase.from("user_roles").delete().match({ user_id: m.id, org_id: orgId });
    const { error } = await supabase.from("user_roles").insert({ user_id: m.id, org_id: orgId, role: next });
    if (error) return toast.error(error.message);
    toast.success("역할이 변경되었습니다.");
    load();
  }

  async function approveMember(p: PendingMember) {
    const { error } = await supabase
      .from("profiles")
      .update({ status: "approved" })
      .eq("id", p.id);
    if (error) return toast.error(error.message);
    toast.success(`${p.name} 님이 승인됐습니다.`);
    load();
  }

  async function rejectMember(p: PendingMember) {
    // 거절 = 기관에서 제거 (org_id null, status approved로 초기화)
    const { error } = await supabase
      .from("profiles")
      .update({ org_id: null, status: "approved" })
      .eq("id", p.id);
    if (error) return toast.error(error.message);
    await supabase.from("user_roles").delete().match({ user_id: p.id, org_id: orgId });
    toast.success(`${p.name} 님의 가입을 거절했습니다.`);
    load();
  }

  async function removeMember(m: Member) {
    if (m.id === currentUserId) return toast.error("본인은 내보낼 수 없습니다.");
    if (m.role === "admin" && adminCount <= 1)
      return toast.error("마지막 관리자는 내보낼 수 없습니다.");

    // 1순위: 관리자 전용 RPC(권한검증·원자적 처리)로 내보내기
    // (생성된 타입에 아직 없는 함수라 rpc 호출만 타입 우회)
    type RpcCall = (
      name: string,
      params: Record<string, unknown>,
    ) => Promise<{ error: { message: string } | null }>;
    const { error: rpcErr } = await (supabase.rpc as unknown as RpcCall)("remove_org_member", {
      target: m.id,
    });
    if (!rpcErr) {
      toast.success(`${m.name} 님을 기관에서 내보냈습니다.`);
      load();
      return;
    }

    // RPC 미설치(함수 없음)면 기존 직접 방식으로 폴백
    const notInstalled = /remove_org_member|function|does not exist|PGRST202|schema cache/i.test(
      rpcErr.message,
    );
    if (!notInstalled) {
      toast.error(rpcErr.message);
      return;
    }

    const { error } = await supabase.from("profiles").update({ org_id: null }).eq("id", m.id);
    if (error) {
      if (/row-level|policy|permission|violates/i.test(error.message)) {
        toast.error(
          "내보내기가 DB 보안정책에 막혀 있어요. Supabase에서 내보내기 함수(SQL)를 한 번 실행해 주세요.",
        );
      } else {
        toast.error(error.message);
      }
      return;
    }
    await supabase.from("user_roles").delete().match({ user_id: m.id, org_id: orgId });
    toast.success(`${m.name} 님을 기관에서 내보냈습니다.`);
    load();
  }

  // 담당자 이름별 담당 대상자 수. 구성원 목록에 없는 이름(퇴사·미가입)은 따로 모아 인수인계를 안내한다.
  const assignedCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of clients) {
      const n = (c.worker_name ?? "").trim();
      if (n) m.set(n, (m.get(n) ?? 0) + 1);
    }
    return m;
  }, [clients]);
  const orphanWorkers = useMemo(() => {
    const names = new Set([...members, ...pendingMembers].map((p) => (p.name ?? "").trim()));
    return [...assignedCount.entries()].filter(([n]) => !names.has(n)).sort((a, b) => a[0].localeCompare(b[0], "ko"));
  }, [assignedCount, members, pendingMembers]);
  const rosterNames = useMemo(() => workerRoster(clients), [clients]);
  const openHandover = (from: string) => {
    setHandoverFrom(from);
    setHandoverOpen(true);
  };

  if (loading) return <div className="text-sm text-muted-foreground">불러오는 중...</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">기관 멤버</h2>
          <p className="text-sm text-muted-foreground">
            총 {members.length}명 · 관리자 {adminCount}명 · 내 역할:{" "}
            {myRole === "admin" ? "관리자" : myRole === "viewer" ? "뷰어" : "멤버"}
          </p>
        </div>
        {isAdmin ? (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => openHandover("")} title="이전 담당자의 대상자를 새 담당자에게 넘기기">
              <ArrowRightLeft className="h-4 w-4 mr-1" />
              담당자 인수인계
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setManageOpen(true)} title="담당자 이름 오타 정정(상담기록 작성자 이름도 함께 바뀜)">
              <UserCog className="h-4 w-4 mr-1" />
              담당자 이름 변경
            </Button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            관리자만 역할 변경/내보내기가 가능합니다.
          </span>
        )}
      </div>

      {/* 구성원 목록에 없는 이름으로 남은 담당 — 관리자만 표시 */}
      {isAdmin && orphanWorkers.length > 0 && (
        <div className="rounded-lg border border-border bg-accent/30 overflow-hidden">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-4 py-2.5 border-b border-border">
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">기관 구성원이 아닌 담당자 {orphanWorkers.length}명</span>
            <span className="text-xs text-muted-foreground">퇴사·미가입 담당자의 대상자를 새 담당자에게 넘겨 주세요.</span>
          </div>
          <ul className="divide-y divide-border">
            {orphanWorkers.map(([name, n]) => (
              <li key={name} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                <span>
                  <span className="font-medium">{name}</span>
                  <span className="ml-2 text-muted-foreground">담당 대상자 {n}명</span>
                </span>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openHandover(name)}>
                  <ArrowRightLeft className="h-3.5 w-3.5 mr-1" />
                  인수인계
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 가입 대기 섹션 — 관리자만 표시 */}
      {isAdmin && pendingMembers.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-100 border-b border-amber-200">
            <Clock className="h-4 w-4 text-amber-600" />
            <span className="text-sm font-semibold text-amber-800">
              가입 승인 대기 {pendingMembers.length}명
            </span>
          </div>
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-xs bg-amber-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium">이름</th>
                <th className="text-left px-4 py-2 font-medium">이메일</th>
                <th className="text-left px-4 py-2 font-medium">연락처</th>
                <th className="text-left px-4 py-2 font-medium">신청일</th>
                <th className="text-right px-4 py-2 font-medium">처리</th>
              </tr>
            </thead>
            <tbody>
              {pendingMembers.map((p) => (
                <tr key={p.id} className="border-t border-amber-200">
                  <td className="px-4 py-2.5 font-medium">{p.name}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{p.email ?? "-"}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{p.phone ?? "-"}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {new Date(p.created_at).toLocaleDateString("ko-KR")}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="default"
                        className="h-7 text-xs"
                        onClick={() => approveMember(p)}
                      >
                        <UserCheck className="h-3.5 w-3.5 mr-1" />
                        승인
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" variant="outline" className="h-7 text-xs text-destructive hover:text-destructive border-destructive/30">
                            <UserX className="h-3.5 w-3.5 mr-1" />
                            거절
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{p.name} 님의 가입을 거절하시겠어요?</AlertDialogTitle>
                            <AlertDialogDescription>
                              해당 사용자는 기관에 합류할 수 없게 됩니다. 기관코드를 다시 입력해 재신청할 수 있습니다.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>취소</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => rejectMember(p)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              거절
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-accent/40 text-muted-foreground text-xs">
            <tr>
              <th className="text-left px-4 py-2 font-medium">이름</th>
              <th className="text-left px-4 py-2 font-medium">이메일</th>
              <th className="text-left px-4 py-2 font-medium">연락처</th>
              <th className="text-left px-4 py-2 font-medium">가입일</th>
              <th className="text-left px-4 py-2 font-medium">역할</th>
              <th className="text-left px-4 py-2 font-medium">담당 대상자</th>
              <th className="text-right px-4 py-2 font-medium">관리</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-t border-border">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    {m.role === "admin" ? (
                      <ShieldCheck className="h-4 w-4 text-primary" />
                    ) : (
                      <UserIcon className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="font-medium">{m.name}</span>
                    {m.id === currentUserId && (
                      <Badge variant="secondary" className="text-[10px]">
                        나
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{m.email ?? "-"}</td>
                <td className="px-4 py-2.5">
                  {isAdmin && editingPhone?.id === m.id ? (
                    <div className="flex items-center gap-1">
                      <Input
                        ref={phoneInputRef}
                        value={editingPhone.value}
                        onChange={(e) => setEditingPhone({ id: m.id, value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") savePhone(m.id, editingPhone.value);
                          if (e.key === "Escape") setEditingPhone(null);
                        }}
                        className="h-7 w-36 text-xs px-2"
                        placeholder="연락처 입력"
                        autoFocus
                        type="tel"
                        disabled={savingPhone}
                      />
                      <button
                        onClick={() => savePhone(m.id, editingPhone.value)}
                        disabled={savingPhone}
                        className="text-primary hover:text-primary/80 disabled:opacity-50"
                        title="저장"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setEditingPhone(null)}
                        className="text-muted-foreground hover:text-foreground"
                        title="취소"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 group">
                      <span className="text-sm text-muted-foreground">{m.phone ?? "-"}</span>
                      {isAdmin && (
                        <button
                          onClick={() => setEditingPhone({ id: m.id, value: m.phone ?? "" })}
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                          title="연락처 수정"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {new Date(m.created_at).toLocaleDateString("ko-KR")}
                </td>
                <td className="px-4 py-2.5">
                  {isAdmin ? (
                    <Select value={m.role} onValueChange={(v) => changeRole(m, v as Role)}>
                      <SelectTrigger className="h-8 w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">관리자</SelectItem>
                        <SelectItem value="member">멤버</SelectItem>
                        <SelectItem value="viewer">뷰어</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant={m.role === "admin" ? "default" : "outline"}>
                      {m.role === "admin" ? "관리자" : m.role === "viewer" ? "뷰어" : "멤버"}
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {(assignedCount.get(m.name.trim()) ?? 0) > 0 ? (
                    <Badge variant="secondary">{assignedCount.get(m.name.trim())}명</Badge>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  {isAdmin && (assignedCount.get(m.name.trim()) ?? 0) > 0 && (
                    <Button size="sm" variant="ghost" className="text-primary hover:text-primary" onClick={() => openHandover(m.name.trim())}>
                      <ArrowRightLeft className="h-4 w-4 mr-1" />
                      인수인계
                    </Button>
                  )}
                  {isAdmin && m.id !== currentUserId && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                        >
                          <UserMinus className="h-4 w-4 mr-1" />
                          내보내기
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{m.name} 님을 내보내시겠어요?</AlertDialogTitle>
                          <AlertDialogDescription>
                            해당 사용자는 이 기관의 데이터에 더 이상 접근할 수 없게 됩니다.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>취소</AlertDialogCancel>
                          <AlertDialogAction onClick={() => removeMember(m)}>
                            내보내기
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  멤버가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <>
          <WorkerHandoverDialog
            open={handoverOpen}
            onOpenChange={setHandoverOpen}
            orgId={orgId}
            clients={clients}
            onChanged={onChanged}
            initialFrom={handoverFrom}
          />
          <WorkerManageDialog
            open={manageOpen}
            onOpenChange={setManageOpen}
            workers={rosterNames}
            clients={clients}
            onChanged={onChanged}
          />
        </>
      )}
    </div>
  );
}
