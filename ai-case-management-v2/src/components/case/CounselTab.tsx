import { ClientName } from "@/components/NameMask";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ScopeFilter } from "./ScopeFilter";
import {
  Loader2,
  Search,
  ChevronsUpDown,
  Check,
  X,
  FileSpreadsheet,
  MessageSquare,
  Package,
} from "lucide-react";
import {
  careLevelOf,
  careLevelStyle,
  workerRoster,
  programsOf,
  programStyle,
  hasCareLevel,
  matchesScope,
  isTerminated,
  type Client,
  type ActivityLog,
  type Provision,
  type OrgRow,
} from "@/lib/case-types";
import type { CarePlanLinkRow } from "@/lib/care-plan-links";
import { cstr, normMethod, parseCounselDate, type LogInsert } from "./counsel/counsel-utils";
import { ChatPanel } from "./counsel/ChatPanel";
import { CounselListView } from "./counsel/CounselListView";
import { ProvisionListView } from "./counsel/ProvisionListView";
import { ProvisionPanel } from "./counsel/ProvisionPanel";
import { BulkSideDishDialog } from "./counsel/BulkSideDishDialog";
import { BulkCaseDialog } from "./counsel/BulkCaseDialog";
import { ResourceChatPanel } from "./counsel/ResourceChatPanel";
import { useClientViewLog } from "@/lib/use-client-view-log";

type Props = {
  clients: Client[];
  logs: ActivityLog[];
  provisions: Provision[];
  org: OrgRow | null;
  workerName: string;
  onChanged: () => void;
  /** 엑셀 업로드 직후 경량 갱신 — activity_logs만 재조회 (< 500ms) */
  onLogsChanged?: () => Promise<void>;
  logsFullyLoaded?: boolean;
  canWrite?: boolean;
  onLoadAllLogs?: () => Promise<void>;
  planLinks?: CarePlanLinkRow[];
};

export function CounselTab({ clients, logs, provisions, org, workerName, onChanged, onLogsChanged, logsFullyLoaded, onLoadAllLogs, canWrite = true, planLinks = [] }: Props) {
  const [innerTab, setInnerTab] = useState<"counsel" | "provision">("counsel");
  const [program, setProgram] = useState("전체");
  const [careFilter, setCareFilter] = useState<"전체" | "중점" | "일반">("전체");
  const [workerFilter, setWorkerFilter] = useState("전체");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [sortMode, setSortMode] = useState<"recent" | "freq">("recent");
  const [searchOpen, setSearchOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkCaseOpen, setBulkCaseOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 밑반찬 일괄 기록용: 담당자·중점구분 필터 무관하게 전체 밑반찬 대상자
  const sideDishClients = useMemo(
    () =>
      clients
        .filter((c) => matchesScope(c, "밑반찬", "전체", "전체"))
        .sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [clients],
  );

  // 사례관리 일괄 제공 기록용: 담당자·중점구분 필터 무관하게 전체 사례관리 대상자
  const caseClients = useMemo(
    () =>
      clients
        .filter((c) => matchesScope(c, "사례관리", "전체", "전체"))
        .sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [clients],
  );

  const allActiveClients = useMemo(
    // 종결은 grade 칸에 저장된다(type 칸이 아님). 예전 값(type "종결")도 함께 거른다.
    () => clients.filter((c) => !isTerminated(c) && c.type !== "종결"),
    [clients],
  );

  // 중복 감지 다이얼로그 상태
  const [dupDialog, setDupDialog] = useState<{
    dupCount: number;
    newRows: LogInsert[];
    allRows: LogInsert[];
    file: File;
    buf: ArrayBuffer;
  } | null>(null);

  // 실제 DB 삽입 (Drive 저장은 백그라운드, onChanged는 호출부에서)
  async function insertRows(rows: LogInsert[], file: File, buf: ArrayBuffer, unmatched: Set<string>) {
    const { error } = await supabase.from("activity_logs").insert(rows);
    if (error) throw error;
    let msg = `상담기록 ${rows.length}건을 등록했습니다.`;
    if (unmatched.size)
      msg += ` (미등록 대상자 ${unmatched.size}명 제외: ${[...unmatched].slice(0, 3).join(", ")}${unmatched.size > 3 ? "…" : ""})`;
    toast.success(msg);
    // Drive 저장: 백그라운드 (UI 블로킹 없음)
    void (async () => {
      try {
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const driveRes = await supabase.functions.invoke("drive-proxy", {
          body: { name: file.name, mimeType: file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: btoa(binary), folderName: "상담기록" },
        });
        if (driveRes.error) toast.warning("Drive 저장 오류: " + driveRes.error.message);
        else if (driveRes.data?.error) toast.warning("Drive 저장 오류: " + driveRes.data.error);
      } catch (e) {
        toast.warning("Drive 저장 실패: " + (e as Error).message);
      }
    })();
  }

  // 상담기록 엑셀 업로드: 대상자명(병합 시 위 값 이어받음)·상담일자·형태·제목·내용 → activity_logs
  async function handleCounselExcel(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !org) return;
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      // 이름 정규화: 앞뒤공백·중간공백·유니코드 NFC 통일
      const normName = (n: string) => n.trim().replace(/\s+/g, "").normalize("NFC");
      const byName = new Map<string, Client>();
      clients.forEach((c) => {
        const key = normName(c.name);
        if (!byName.has(key)) byName.set(key, c);
      });
      const rows: LogInsert[] = [];
      const unmatched = new Set<string>();
      for (const sheetName of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
          header: 1,
          defval: null,
          blankrows: false,
        });
        const hIdx = aoa.findIndex(
          (r) => Array.isArray(r) && r.some((c) => cstr(c) === "대상자명"),
        );
        if (hIdx < 0) continue;
        const header = (aoa[hIdx] as unknown[]).map((c) => cstr(c) ?? "");
        const col = (labels: string[]) =>
          header.findIndex((h) => h && labels.some((l) => h.includes(l)));
        const iName = col(["대상자명", "이름", "성명"]);
        const iDate = col(["상담일자", "일자", "날짜"]);
        const iType = col(["상담형태", "형태", "방법", "유형"]);
        const iTitle = col(["상담제목", "제목"]);
        const iContent = col(["상담내용", "내용"]);
        if (iName < 0) continue;
        let lastName = "";
        for (const r of aoa.slice(hIdx + 1)) {
          const nm = cstr(r[iName]);
          if (nm) lastName = nm;
          const name = lastName;
          const title = iTitle >= 0 ? cstr(r[iTitle]) : null;
          const content = iContent >= 0 ? cstr(r[iContent]) : null;
          if (!name || (!title && !content)) continue;
          const client = byName.get(normName(name));
          if (!client) {
            unmatched.add(name);
            continue;
          }
          const created = parseCounselDate(iDate >= 0 ? r[iDate] : null);
          rows.push({
            client_id: client.id,
            org_id: org.id,
            method: normMethod(iType >= 0 ? cstr(r[iType]) : null),
            note: [title, content].filter(Boolean).join("\n"),
            worker_name: client.worker_name ?? workerName,
            ...(created ? { created_at: created } : {}),
          });
        }
      }
      if (rows.length === 0) {
        toast.error(
          unmatched.size
            ? `일치하는 대상자가 없습니다: ${[...unmatched].slice(0, 5).join(", ")}`
            : "가져올 상담기록을 찾지 못했습니다. ('대상자명' 헤더 확인)",
        );
        return;
      }
      // ── 중복 감지: 기존 로그와 note + client_id 비교 ──
      const existingKeys = new Set(
        logs.map((l) => `${l.client_id}||${(l.note ?? "").trim()}`)
      );
      const newRows = rows.filter(
        (r) => !existingKeys.has(`${r.client_id}||${(r.note ?? "").trim()}`)
      );
      const dupCount = rows.length - newRows.length;

      if (dupCount > 0) {
        // 중복 있음 → 다이얼로그로 사용자에게 선택 요청
        setDupDialog({ dupCount, newRows, allRows: rows, file, buf });
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
        return;
      }

      await insertRows(rows, file, buf, unmatched);
      // 경량 갱신(activity_logs만 재조회) → 즉시 화면 반영
      await (onLogsChanged ?? onChanged)();
    } catch (err) {
      toast.error("업로드 실패: " + (err as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const workers = useMemo(() => workerRoster(clients), [clients]);
  const filteredClients = useMemo(
    () =>
      clients
        .filter((c) => matchesScope(c, program, careFilter, workerFilter))
        .sort((a, b) => a.name.localeCompare(b.name, "ko")), // 가나다순
    [clients, program, careFilter, workerFilter],
  );

  // 전체 상담기록 키워드 검색: 키워드가 포함된 기록을 대상자별로 집계 (건수·최근일)
  const filteredIds = useMemo(() => new Set(filteredClients.map((c) => c.id)), [filteredClients]);
  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const searchResults = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return [];
    const acc = new Map<string, { client: Client; count: number; last: number }>();
    for (const l of logs) {
      if (!filteredIds.has(l.client_id)) continue;
      const text = ((l.note ?? "") + " " + (l.transcript ?? "")).toLowerCase();
      if (!text.includes(kw)) continue;
      const client = clientById.get(l.client_id);
      if (!client) continue;
      const t = new Date(l.created_at).getTime();
      const cur = acc.get(l.client_id);
      if (cur) {
        cur.count += 1;
        if (t > cur.last) cur.last = t;
      } else {
        acc.set(l.client_id, { client, count: 1, last: t });
      }
    }
    const arr = [...acc.values()];
    arr.sort((a, b) =>
      sortMode === "freq" ? b.count - a.count || b.last - a.last : b.last - a.last,
    );
    return arr;
  }, [logs, clientById, filteredIds, keyword, sortMode]);

  // 선택 대상자 유지/초기화
  useEffect(() => {
    if (selectedId && !filteredClients.some((c) => c.id === selectedId)) setSelectedId(null);
  }, [filteredClients, selectedId]);

  const selected = clients.find((c) => c.id === selectedId) ?? null;
  useClientViewLog(selected, "상담");
  const thread = useMemo(
    () =>
      logs
        .filter((l) => l.client_id === selectedId)
        .slice()
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [logs, selectedId],
  );

  const [loadingAll, setLoadingAll] = useState(false);

  async function handleLoadAllLogs() {
    if (!onLoadAllLogs) return;
    setLoadingAll(true);
    try { await onLoadAllLogs(); } finally { setLoadingAll(false); }
  }

  return (
    <>
    {/* 12개월 초기 로딩 안내 배너 */}
    {!logsFullyLoaded && onLoadAllLogs && (
      <div className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground bg-muted/40 border-b border-border">
        <span>최근 12개월 기록을 표시하고 있습니다.</span>
        <button
          className="underline text-primary hover:opacity-70 font-medium disabled:opacity-40"
          onClick={handleLoadAllLogs}
          disabled={loadingAll}
        >
          {loadingAll ? "불러오는 중..." : "전체 기록 보기"}
        </button>
      </div>
    )}
    <div className="space-y-3">
      {/* 사업 구분 필터 */}
      <ScopeFilter
        program={program}
        onProgram={setProgram}
        care={careFilter}
        onCare={setCareFilter}
        worker={workerFilter}
        onWorker={setWorkerFilter}
        workers={workers}
      />

      {/* 상담 / 제공이력 서브탭 */}
      <div className="flex items-center gap-1 border-b border-border pb-0">
        <button
          type="button"
          onClick={() => setInnerTab("counsel")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            innerTab === "counsel"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <span className="flex items-center gap-1.5">
            <MessageSquare className="h-4 w-4" />
            상담
          </span>
        </button>
        <button
          type="button"
          onClick={() => setInnerTab("provision")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            innerTab === "provision"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <span className="flex items-center gap-1.5">
            <Package className="h-4 w-4" />
            제공이력
          </span>
        </button>
      </div>

      {/* 상단: 대상자 검색·선택 (목록을 펼치지 않고 검색으로 선택) */}
      <div className="flex flex-wrap items-center gap-2">
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={pickerOpen}
              className="justify-between min-w-[220px] max-w-full"
            >
              <span className="flex items-center gap-2 truncate">
                <Search className="h-4 w-4 shrink-0 opacity-60" />
                {selected ? (
                  <>
                    <span className="truncate"><ClientName c={selected} /></span>
                    {hasCareLevel(selected) && (
                      <Badge
                        variant="outline"
                        className={`text-[10px] px-1.5 py-0 ${careLevelStyle[careLevelOf(selected)] ?? ""}`}
                      >
                        {careLevelOf(selected)}
                      </Badge>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">대상자 검색·선택</span>
                )}
              </span>
              {selected ? (
                <span
                  role="button"
                  aria-label="선택 취소"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedId(null);
                  }}
                  className="shrink-0 rounded-sm p-0.5 hover:bg-accent hover:text-foreground text-muted-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </span>
              ) : (
                <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-60" />
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[300px] p-0" align="start">
            <Command>
              <CommandInput placeholder="이름·연락처 검색" />
              <CommandList>
                <CommandEmpty>일치하는 대상자가 없습니다.</CommandEmpty>
                <CommandGroup>
                  {filteredClients.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={`${c.name} ${c.phone ?? ""}`}
                      onSelect={() => {
                        setSelectedId(c.id);
                        setPickerOpen(false);
                      }}
                    >
                      <Check
                        className={`mr-2 h-4 w-4 shrink-0 ${selectedId === c.id ? "opacity-100" : "opacity-0"}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium truncate"><ClientName c={c} /></span>
                          {programsOf(c).map((p) => (
                            <Badge
                              key={p}
                              variant="outline"
                              className={`text-[10px] px-1.5 py-0 ${programStyle[p] ?? ""}`}
                            >
                              {p}
                            </Badge>
                          ))}
                          {hasCareLevel(c) && (
                            <Badge
                              variant="outline"
                              className={`text-[10px] px-1.5 py-0 ${careLevelStyle[careLevelOf(c)] ?? ""}`}
                            >
                              {careLevelOf(c)}
                            </Badge>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          담당 {c.worker_name ?? "미배정"}
                        </div>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={handleCounselExcel}
        />
        <div className="flex items-center gap-2 ml-auto">
          {canWrite && innerTab === "provision" && program === "밑반찬" && (
            <Button
              size="sm"
              onClick={() => setBulkOpen(true)}
              title="밑반찬 일괄 배달 기록"
            >
              <Package className="h-4 w-4" />
              일괄 배달 기록
            </Button>
          )}
          {canWrite && innerTab === "provision" && program === "사례관리" && (
            <Button
              size="sm"
              onClick={() => setBulkCaseOpen(true)}
              title="사례관리 일괄 제공 기록"
            >
              <Package className="h-4 w-4" />
              일괄 제공 기록
            </Button>
          )}
          {innerTab === "counsel" && (
            <>
              {canWrite && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                title="상담기록 엑셀 업로드 (대상자명·상담일자·형태·제목·내용)"
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FileSpreadsheet className="h-4 w-4" />
                )}
                <span className="hidden sm:inline">상담기록 엑셀</span>
              </Button>
              )}
              <Button
                size="sm"
                variant={searchOpen ? "default" : "outline"}
                onClick={() => {
                  if (searchOpen) {
                    setSearchOpen(false);
                    setKeyword("");
                  } else {
                    setSearchOpen(true);
                  }
                }}
                title="전체 상담기록 키워드 검색"
                aria-label="전체 상담기록 검색"
              >
                <Search className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 밑반찬 일괄 배달 기록 다이얼로그 */}
      {bulkOpen && org && (
        <BulkSideDishDialog
          open={bulkOpen}
          onOpenChange={setBulkOpen}
          clients={sideDishClients}
          orgId={org.id}
          workerName={workerName}
          onSaved={async () => {
            await onLogsChanged?.();
            onChanged();
          }}
        />
      )}

      {/* 사례관리 일괄 제공 기록 다이얼로그 */}
      {bulkCaseOpen && org && (
        <BulkCaseDialog
          open={bulkCaseOpen}
          onOpenChange={setBulkCaseOpen}
          clients={caseClients}
          orgId={org.id}
          workerName={workerName}
          onSaved={async () => {
            await onLogsChanged?.();
            onChanged();
          }}
        />
      )}

      {/* 전체 상담기록 키워드 검색 (돋보기 클릭 시 표시) */}
      {searchOpen && (
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="전체 상담기록 키워드 검색 (예: 선풍기)"
              className="pl-9"
              autoFocus
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setKeyword("");
              setSearchOpen(false);
            }}
          >
            <X className="h-4 w-4" />
            닫기
          </Button>
        </div>
      )}

      {/* 검색 결과: 키워드가 포함된 어르신 목록 */}
      {keyword.trim() && (
        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border flex-wrap">
            <span className="text-sm">
              <b className="text-primary">'{keyword.trim()}'</b> 검색 — {searchResults.length}명
            </span>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">정렬</span>
              <Button
                size="sm"
                variant={sortMode === "recent" ? "default" : "outline"}
                className="h-7"
                onClick={() => setSortMode("recent")}
              >
                최근순
              </Button>
              <Button
                size="sm"
                variant={sortMode === "freq" ? "default" : "outline"}
                className="h-7"
                onClick={() => setSortMode("freq")}
              >
                빈도순
              </Button>
            </div>
          </div>
          <div className="max-h-[32vh] overflow-y-auto divide-y divide-border">
            {searchResults.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">
                해당 키워드가 포함된 상담기록이 없습니다.
              </p>
            )}
            {searchResults.map(({ client, count, last }) => (
              <button
                key={client.id}
                onClick={() => setSelectedId(client.id)}
                className={`w-full text-left px-3 py-2 transition-colors ${selectedId === client.id ? "bg-accent" : "hover:bg-accent/40"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="font-medium truncate"><ClientName c={client} /></span>
                    {hasCareLevel(client) && (
                      <Badge
                        variant="outline"
                        className={`text-[10px] px-1.5 py-0 ${careLevelStyle[careLevelOf(client)] ?? ""}`}
                      >
                        {careLevelOf(client)}
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {count}건 · 최근 {new Date(last).toLocaleDateString("ko-KR")}
                  </span>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {client.type} · 담당 {client.worker_name ?? "미배정"}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 상담 패널 / 제공이력 패널 */}
      {innerTab === "counsel" ? (
        selected ? (
          <ChatPanel
            key={selected.id}
            client={selected}
            thread={thread}
            logs={logs}
            workerName={workerName}
            initialKeyword={keyword}
            onChanged={onChanged}
            canWrite={canWrite}
            planLinks={planLinks}
            provisions={provisions.filter((p) => p.client_id === selected.id)}
          />
        ) : keyword.trim() ? null : (
          <CounselListView
            clients={filteredClients}
            logs={logs}
            provisions={provisions}
            onSelectClient={(id) => setSelectedId(id)}
            onSelectProvision={(id) => { setSelectedId(id); setInnerTab("provision"); }}
            onChanged={onChanged}
          />
        )
      ) : (
        selected ? (
          <ProvisionPanel
            key={selected.id}
            client={selected}
            provisions={provisions.filter((p) => p.client_id === selected.id)}
            org={org}
            workerName={workerName}
            onChanged={onChanged}
            planLinks={planLinks}
          />
        ) : (
          <>
            <ProvisionListView
              clients={filteredClients}
              provisions={provisions}
              onSelectClient={(id) => setSelectedId(id)}
              onChanged={onChanged}
            />
            <ResourceChatPanel
              clients={allActiveClients}
              logs={logs}
              provisions={provisions}
              org={org}
              workerName={workerName}
              onSelectClient={(id) => { setSelectedId(id); setInnerTab("counsel"); }}
              onChanged={onChanged}
              onLogsChanged={onLogsChanged}
            />
          </>
        )
      )}
    </div>

    {/* 중복 감지 다이얼로그 */}
    {dupDialog && (
      <Dialog open onOpenChange={() => setDupDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>중복 상담기록 발견</DialogTitle>
            <DialogDescription>
              엑셀에서 가져온 <b>{dupDialog.allRows.length}건</b> 중{" "}
              <b>{dupDialog.dupCount}건</b>이 이미 등록된 기록과 동일합니다.
              어떻게 처리할까요?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={async () => {
                const d = dupDialog;
                setDupDialog(null);
                if (d.newRows.length === 0) {
                  toast.info("모두 중복이라 등록할 기록이 없습니다.");
                  return;
                }
                setUploading(true);
                try {
                  await insertRows(d.newRows, d.file, d.buf, new Set());
                  await (onLogsChanged ?? onChanged)();
                } catch (err) {
                  toast.error("등록 실패: " + (err as Error).message);
                } finally {
                  setUploading(false);
                }
              }}
            >
              중복 건너뛰기 ({dupDialog.newRows.length}건만 등록)
            </Button>
            <Button
              onClick={async () => {
                const d = dupDialog;
                setDupDialog(null);
                setUploading(true);
                try {
                  await insertRows(d.allRows, d.file, d.buf, new Set());
                  await (onLogsChanged ?? onChanged)();
                } catch (err) {
                  toast.error("등록 실패: " + (err as Error).message);
                } finally {
                  setUploading(false);
                }
              }}
            >
              전체 등록 ({dupDialog.allRows.length}건)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )}
    </>
  );
}
