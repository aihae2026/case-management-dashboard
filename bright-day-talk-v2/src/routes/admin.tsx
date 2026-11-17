import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  checkIsAdmin,
  listAllRegistrations,
  approveRegistration,
  rejectRegistration,
  revokeRegistration,
  deleteRegistration,
  updateCareKeywords,
} from "@/lib/registration.functions";

export const Route = createFileRoute("/admin")({
  // 관리자 전용 manifest — 흑백 아이콘, 별도 PWA로 설치 가능
  head: () => ({
    meta: [
      { name: "theme-color", content: "#4A4A4A" },
      { name: "apple-mobile-web-app-title", content: "관리자" },
    ],
    links: [
      { rel: "manifest", href: "/manifest-admin.json" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon-admin.png" },
    ],
  }),
  component: AdminPage,
});

type Reg = {
  id: string;
  session_id: string;
  org_code: string;
  org_name: string | null;
  senior_name: string;
  senior_phone: string;
  status: "pending" | "approved" | "rejected";
  rejection_reason: string | null;
  created_at: string;
  approved_at: string | null;
  approved_by_email: string | null;
  ip_address?: string | null;
  device_hint?: string | null;
  last_active_at?: string | null;
  short_code?: string | null;
  birth_code?: string | null;
  care_keywords?: string[] | null;
};

type PageState = "loading" | "need_login" | "not_admin" | "load_error" | "ready";

function AdminPage() {
  const [state, setState] = useState<PageState>("loading");
  const [adminEmail, setAdminEmail] = useState("");
  const [registrations, setRegistrations] = useState<Reg[]>([]);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});
  const [keywordsSaving, setKeywordsSaving] = useState<string | null>(null); // session_id 기준

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { setState("need_login"); return; }
      const token = data.session.access_token;
      checkIsAdmin({ data: { token } })
        .then(({ isAdmin, email }) => {
          if (!isAdmin) { setState("not_admin"); setAdminEmail(email); return; }
          setAdminEmail(email);
          return loadList(token);
        })
        .catch(() => setState("load_error"));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getToken = async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  };

  const loadList = async (token?: string) => {
    setState("loading");
    try {
      const t = token ?? await getToken();
      const { registrations: list } = await listAllRegistrations({ data: { token: t } });
      setRegistrations(list as Reg[]);
      setState("ready");
    } catch {
      setState("load_error");
    }
  };

  const handleApprove = async (id: string) => {
    setActionLoading(id);
    try {
      const token = await getToken();
      await approveRegistration({ data: { token, id } });
      setRegistrations((prev) =>
        prev.map((r) =>
          r.id === id
            ? { ...r, status: "approved", approved_at: new Date().toISOString(), approved_by_email: adminEmail }
            : r,
        ),
      );
    } catch (e) {
      toast.error("승인 중 오류: " + String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (id: string) => {
    const reason = rejectReason[id] ?? "";
    setActionLoading(id);
    try {
      const token = await getToken();
      await rejectRegistration({ data: { token, id, reason: reason || undefined } });
      setRegistrations((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, status: "rejected", rejection_reason: reason || null } : r,
        ),
      );
    } catch (e) {
      toast.error("거절 중 오류: " + String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleRevoke = (id: string) => {
    toast("승인을 해제하면 대상자 기기에서 자동 로그아웃됩니다.", {
      action: { label: "해제", onClick: () => void doRevoke(id) },
      cancel: { label: "취소", onClick: () => {} },
      duration: 8000,
    });
  };
  const doRevoke = async (id: string) => {
    if (actionLoading !== null) return; // (R-M2) 중복 실행 방지
    setActionLoading(id);
    try {
      const token = await getToken();
      await revokeRegistration({ data: { token, id } });
      setRegistrations((prev) =>
        prev.map((r) =>
          r.id === id
            ? { ...r, status: "pending", approved_at: null, approved_by_email: null, rejection_reason: null }
            : r,
        ),
      );
    } catch (e) {
      toast.error("승인 해제 중 오류: " + String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleUpdateKeywords = async (sessionId: string, keywords: string[]) => {
    setKeywordsSaving(sessionId);
    try {
      const token = await getToken();
      await updateCareKeywords({ data: { token, sessionId, keywords } });
      setRegistrations((prev) =>
        prev.map((r) => r.session_id === sessionId ? { ...r, care_keywords: keywords } : r),
      );
    } catch (e) {
      toast.error("키워드 저장 중 오류: " + String(e));
    } finally {
      setKeywordsSaving(null);
    }
  };

  const handleDelete = (id: string, name: string) => {
    toast(`"${name}" 대상자의 등록 정보를 완전히 삭제할까요? 대상자 기기도 초기화됩니다.`, {
      action: { label: "삭제", onClick: () => void doDelete(id) },
      cancel: { label: "취소", onClick: () => {} },
      duration: 8000,
    });
  };
  const doDelete = async (id: string) => {
    if (actionLoading !== null) return; // (R-M2) 중복 실행 방지
    setActionLoading(id);
    try {
      const token = await getToken();
      await deleteRegistration({ data: { token, id } });
      setRegistrations((prev) => prev.filter((r) => r.id !== id));
      setRejectReason((prev) => { const n = { ...prev }; delete n[id]; return n; }); // (R-L2) 잔여 상태 정리
    } catch (e) {
      toast.error("삭제 중 오류: " + String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleGoogleLogin = async () => {
    try { sessionStorage.setItem("auth_next", "/admin"); } catch { /* ignore */ }
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: { prompt: "select_account" },
      },
    });
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setState("need_login");
    setRegistrations([]);
  };

  // ── 로딩 ──
  if (state === "loading") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <p className="text-lg font-bold text-muted-foreground">불러오는 중…</p>
      </div>
    );
  }

  // ── 로그인 필요 ──
  if (state === "need_login") {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-6">
        <h1 className="mb-4 text-2xl font-extrabold text-foreground">관리자 로그인</h1>
        <p className="mb-6 text-sm text-muted-foreground">관리자 Google 계정으로 로그인하세요.</p>
        <button
          type="button"
          onClick={handleGoogleLogin}
          className="flex items-center gap-3 rounded-2xl border-2 border-border bg-background px-6 py-4 text-base font-bold text-foreground"
        >
          <GoogleIcon />
          Google로 로그인
        </button>
      </div>
    );
  }

  // ── 권한 없음 ──
  if (state === "not_admin") {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-6 text-center">
        <div className="mb-4 text-5xl">🔒</div>
        <h1 className="text-xl font-extrabold text-foreground">접근 권한이 없습니다</h1>
        {adminEmail && <p className="mt-2 text-sm text-muted-foreground">현재 로그인: {adminEmail}</p>}
        <button
          type="button"
          onClick={handleLogout}
          className="mt-6 rounded-xl border-2 border-border bg-background px-5 py-2.5 text-sm font-semibold text-muted-foreground"
        >
          로그아웃 후 다시 시도
        </button>
      </div>
    );
  }

  // ── 네트워크/서버 오류 ──
  if (state === "load_error") {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-6 text-center">
        <div className="mb-4 text-5xl">⚠️</div>
        <h1 className="text-xl font-extrabold text-foreground">불러오기 실패</h1>
        <p className="mt-2 text-sm text-muted-foreground">네트워크 오류가 발생했어요. 잠시 후 다시 시도해 주세요.</p>
        <button
          type="button"
          onClick={() => loadList()}
          className="mt-6 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
        >
          다시 시도
        </button>
      </div>
    );
  }

  // ── ready ──
  const pending = registrations.filter((r) => r.status === "pending");
  const approved = registrations.filter((r) => r.status === "approved");
  const rejected = registrations.filter((r) => r.status === "rejected");

  return (
    <div className="min-h-[100dvh] bg-background px-4 py-8">
      <div className="mx-auto max-w-2xl">
        {/* 헤더 */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-extrabold text-foreground">복순이 관리자</h1>
            <p className="text-sm text-muted-foreground">{adminEmail}</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => loadList()}
              className="rounded-xl border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground"
            >
              새로고침
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-xl border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground"
            >
              로그아웃
            </button>
          </div>
        </div>

        {/* 대기 중 */}
        <section className="mb-8">
          <SectionTitle label="승인 대기" count={pending.length} color="yellow" />
          {pending.length === 0 ? (
            <EmptyBox text="대기 중인 요청이 없어요" />
          ) : (
            <div className="flex flex-col gap-3">
              {pending.map((r) => (
                <RegCard
                  key={r.id}
                  reg={r}
                  loading={actionLoading === r.id}
                  disabled={actionLoading !== null}
                  rejectReason={rejectReason[r.id] ?? ""}
                  onRejectReasonChange={(v) => setRejectReason((p) => ({ ...p, [r.id]: v }))}
                  onApprove={() => handleApprove(r.id)}
                  onReject={() => handleReject(r.id)}
                  onRevoke={() => handleRevoke(r.id)}
                  onDelete={() => handleDelete(r.id, r.senior_name)}
                  keywordsSaving={keywordsSaving === r.session_id}
                  onSaveKeywords={(kws) => handleUpdateKeywords(r.session_id, kws)}
                />
              ))}
            </div>
          )}
        </section>

        {/* 승인 완료 */}
        <section className="mb-8">
          <SectionTitle label="승인 완료" count={approved.length} color="green" />
          {approved.length === 0 ? (
            <EmptyBox text="승인된 대상자가 없어요" />
          ) : (
            <div className="flex flex-col gap-3">
              {approved.map((r) => (
                <RegCard
                  key={r.id}
                  reg={r}
                  loading={actionLoading === r.id}
                  disabled={actionLoading !== null}
                  rejectReason={rejectReason[r.id] ?? ""}
                  onRejectReasonChange={(v) => setRejectReason((p) => ({ ...p, [r.id]: v }))}
                  onApprove={() => handleApprove(r.id)}
                  onReject={() => handleReject(r.id)}
                  onRevoke={() => handleRevoke(r.id)}
                  onDelete={() => handleDelete(r.id, r.senior_name)}
                  keywordsSaving={keywordsSaving === r.session_id}
                  onSaveKeywords={(kws) => handleUpdateKeywords(r.session_id, kws)}
                />
              ))}
            </div>
          )}
        </section>

        {/* 거절 */}
        {rejected.length > 0 && (
          <section>
            <SectionTitle label="거절됨" count={rejected.length} color="red" />
            <div className="flex flex-col gap-3">
              {rejected.map((r) => (
                <RegCard
                  key={r.id}
                  reg={r}
                  loading={actionLoading === r.id}
                  disabled={actionLoading !== null}
                  rejectReason={rejectReason[r.id] ?? ""}
                  onRejectReasonChange={(v) => setRejectReason((p) => ({ ...p, [r.id]: v }))}
                  onApprove={() => handleApprove(r.id)}
                  onReject={() => handleReject(r.id)}
                  onRevoke={() => handleRevoke(r.id)}
                  onDelete={() => handleDelete(r.id, r.senior_name)}
                  keywordsSaving={keywordsSaving === r.session_id}
                  onSaveKeywords={(kws) => handleUpdateKeywords(r.session_id, kws)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ── 섹션 타이틀 ──────────────────────────────────
function SectionTitle({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: "yellow" | "green" | "red";
}) {
  const badge = {
    yellow: "bg-yellow-100 text-yellow-800",
    green: "bg-green-100 text-green-800",
    red: "bg-red-100 text-red-800",
  }[color];

  return (
    <h2 className="mb-3 flex items-center gap-2 text-lg font-bold text-foreground">
      {label}
      {count > 0 && (
        <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${badge}`}>{count}</span>
      )}
    </h2>
  );
}

function EmptyBox({ text }: { text: string }) {
  return (
    <p className="rounded-2xl bg-muted px-4 py-6 text-center text-sm text-muted-foreground">
      {text}
    </p>
  );
}

// YYMMDD → "YY년 MM월 DD일" 표시 헬퍼
function formatBirthCode(code: string | null | undefined): string {
  if (!code || code.length !== 6) return "-";
  return `${code.slice(0, 2)}년 ${code.slice(2, 4)}월 ${code.slice(4, 6)}일`;
}

// ── 카드 ──────────────────────────────────────────
function RegCard({
  reg,
  loading,
  disabled,
  rejectReason,
  onRejectReasonChange,
  onApprove,
  onReject,
  onRevoke,
  onDelete,
  keywordsSaving,
  onSaveKeywords,
}: {
  reg: Reg;
  loading: boolean;
  disabled: boolean;
  rejectReason: string;
  onRejectReasonChange: (v: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onRevoke: () => void;
  onDelete: () => void;
  keywordsSaving: boolean;
  onSaveKeywords: (keywords: string[]) => void;
}) {
  const [editKeywords, setEditKeywords] = useState<string[]>(reg.care_keywords ?? []);
  const [newKw, setNewKw] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // (R-M1) 부모 re-render 시 prop 변경 동기화
  useEffect(() => {
    setEditKeywords(reg.care_keywords ?? []);
  }, [reg.care_keywords]);

  const addKeyword = () => {
    const trimmed = newKw.trim();
    if (!trimmed || editKeywords.length >= 3 || editKeywords.includes(trimmed)) return;
    setEditKeywords((prev) => [...prev, trimmed]);
    setNewKw("");
    inputRef.current?.focus();
  };

  const removeKeyword = (kw: string) => setEditKeywords((prev) => prev.filter((k) => k !== kw));

  const isDirty =
    JSON.stringify(editKeywords) !== JSON.stringify(reg.care_keywords ?? []);
  const statusBadge = {
    pending: "bg-yellow-100 text-yellow-800",
    approved: "bg-green-100 text-green-800",
    rejected: "bg-red-100 text-red-800",
  }[reg.status];

  const statusLabel = { pending: "대기 중", approved: "승인됨", rejected: "거절됨" }[reg.status];

  return (
    <div className="rounded-2xl bg-card p-4 shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold text-foreground">{reg.senior_name}</p>
          <p className="truncate text-xs text-muted-foreground">{reg.org_name || reg.org_code}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${statusBadge}`}>
          {statusLabel}
        </span>
      </div>

      {/* 접속 코드 + 생년월일 */}
      {(reg.short_code || reg.birth_code) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {reg.short_code && (
            <>
              <span className="text-xs font-semibold text-muted-foreground">접속 코드</span>
              <span className="rounded-xl bg-primary/10 px-3 py-1 font-mono text-xl font-extrabold tracking-[0.25em] text-primary">
                {reg.short_code}
              </span>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(reg.short_code!)}
                className="rounded-lg border border-border bg-background px-2 py-1 text-xs font-semibold text-muted-foreground active:scale-95"
              >
                복사
              </button>
            </>
          )}
          {reg.birth_code && (
            <>
              <span className="text-xs font-semibold text-muted-foreground">생년월일</span>
              <span className="rounded-xl bg-secondary px-3 py-1 font-mono text-sm font-bold text-foreground">
                {formatBirthCode(reg.birth_code)}
              </span>
            </>
          )}
        </div>
      )}

      <div className="mt-2 text-sm text-muted-foreground">
        <p>
          <span className="font-semibold text-foreground">기관</span>{" "}
          {reg.org_name || reg.org_code}
        </p>
        <p>
          <span className="font-semibold text-foreground">연락처</span>{" "}
          {reg.senior_phone}
        </p>
        <p className="mt-1 text-xs">신청: {new Date(reg.created_at).toLocaleString("ko-KR")}</p>
        {(reg.device_hint || reg.ip_address) && (
          <p className="mt-0.5 text-xs text-muted-foreground/70">
            {reg.device_hint && <span>{reg.device_hint}</span>}
            {reg.device_hint && reg.ip_address && <span className="mx-1">·</span>}
            {reg.ip_address && <span className="font-mono">{reg.ip_address}</span>}
          </p>
        )}
        {reg.approved_at && (
          <p className="text-xs">
            승인: {new Date(reg.approved_at).toLocaleString("ko-KR")}
            {reg.approved_by_email && ` (${reg.approved_by_email})`}
          </p>
        )}
        {reg.last_active_at && (
          <p className="mt-0.5 text-xs font-semibold text-primary/80">
            최근 사용: {new Date(reg.last_active_at).toLocaleString("ko-KR")}
          </p>
        )}
        {reg.rejection_reason && (
          <p className="mt-1 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
            거절 사유: {reg.rejection_reason}
          </p>
        )}
      </div>

      {/* 대화 키워드 — 승인된 어르신(접속 이력 있음)에게만 표시 */}
      {reg.status === "approved" && reg.short_code && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
            🗝️ 대화 확인 키워드
            <span className="ml-1 font-normal text-muted-foreground/60">(최대 3개 · 복순이만 볼 수 있어요)</span>
          </p>

          {/* 현재 태그 목록 */}
          <div className="mb-2 flex flex-wrap gap-1.5">
            {editKeywords.length === 0 && (
              <span className="text-xs text-muted-foreground/50">설정된 키워드가 없어요</span>
            )}
            {editKeywords.map((kw) => (
              <span
                key={kw}
                className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary"
              >
                {kw}
                <button
                  type="button"
                  onClick={() => removeKeyword(kw)}
                  className="ml-0.5 text-primary/60 hover:text-destructive"
                  aria-label={`${kw} 삭제`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          {/* 입력 + 추가 */}
          {editKeywords.length < 3 && (
            <div className="mb-2 flex gap-1.5">
              <input
                ref={inputRef}
                type="text"
                value={newKw}
                onChange={(e) => setNewKw(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addKeyword(); } }}
                placeholder="예: 치매, 우울, 낙상"
                maxLength={50}
                className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-ring"
              />
              <button
                type="button"
                onClick={addKeyword}
                disabled={!newKw.trim()}
                className="shrink-0 rounded-xl bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary disabled:opacity-40"
              >
                추가
              </button>
            </div>
          )}

          {/* 저장 버튼 */}
          <button
            type="button"
            onClick={() => onSaveKeywords(editKeywords)}
            disabled={disabled || keywordsSaving || !isDirty}
            className="w-full rounded-xl border-2 border-primary/30 bg-primary/5 py-2 text-sm font-bold text-primary disabled:opacity-40"
          >
            {keywordsSaving ? "저장 중…" : isDirty ? "💾 저장" : "✓ 저장됨"}
          </button>
        </div>
      )}

      {/* 대기 중: 승인/거절 버튼 */}
      {reg.status === "pending" && (
        <div className="mt-3 flex flex-col gap-2">
          <input
            type="text"
            value={rejectReason}
            onChange={(e) => onRejectReasonChange(e.target.value)}
            placeholder="거절 사유 (선택사항)"
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onReject}
              disabled={disabled}
              className="flex-1 rounded-xl border-2 border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-bold text-destructive disabled:opacity-60"
            >
              거절
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={disabled}
              className="flex-[2] rounded-xl bg-primary px-3 py-2 text-sm font-bold text-primary-foreground disabled:opacity-60"
            >
              {loading ? "처리 중…" : "✓ 승인"}
            </button>
          </div>
        </div>
      )}

      {/* 승인됨: 승인 해제 + 삭제 버튼 */}
      {reg.status === "approved" && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onRevoke}
            disabled={disabled}
            className="flex-1 rounded-xl border-2 border-orange-300 bg-orange-50 px-3 py-2 text-sm font-bold text-orange-700 disabled:opacity-60"
          >
            {loading ? "처리 중…" : "🔓 승인 해제"}
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={disabled}
            className="rounded-xl border-2 border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-bold text-destructive disabled:opacity-60"
          >
            삭제
          </button>
        </div>
      )}

      {/* 거절됨: 재승인 + 삭제 버튼 */}
      {reg.status === "rejected" && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onApprove}
            disabled={disabled}
            className="flex-1 rounded-xl bg-primary px-3 py-2 text-sm font-bold text-primary-foreground disabled:opacity-60"
          >
            {loading ? "처리 중…" : "재승인"}
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={disabled}
            className="rounded-xl border-2 border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-bold text-destructive disabled:opacity-60"
          >
            삭제
          </button>
        </div>
      )}
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.2H42V20H24v8h11.3C33.7 32.5 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34.1 6.7 29.3 4.5 24 4.5 12.7 4.5 3.5 13.7 3.5 25S12.7 45.5 24 45.5 44.5 36.3 44.5 25c0-1.6-.2-3.2-.9-4.8z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.5 15.9 18.9 13 24 13c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34.1 6.7 29.3 4.5 24 4.5c-7.7 0-14.3 4.3-17.7 10.2z" />
      <path fill="#4CAF50" d="M24 45.5c5.2 0 9.9-1.9 13.5-5.1l-6.2-5.3C29.3 37 26.8 38 24 38c-5.2 0-9.7-3.5-11.3-8.3l-6.5 5C9.7 41.1 16.4 45.5 24 45.5z" />
      <path fill="#1976D2" d="M43.6 20.2H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.3 5.7l6.2 5.3C37 39 44.5 34 44.5 25c0-1.6-.2-3.2-.9-4.8z" />
    </svg>
  );
}
