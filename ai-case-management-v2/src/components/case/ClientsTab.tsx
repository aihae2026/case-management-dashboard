import { ClientName } from "@/components/NameMask";
import { formatLogDateTime, toKstDate } from "@/lib/log-time";
import { programDefaultWorker, workerFromSheetName } from "@/lib/worker-defaults";
import { useNameMask } from "@/lib/name-mask-context";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConsentSignatureDialog } from "@/components/case/ConsentSignatureDialog";
import { supabase } from "@/integrations/supabase/client";
import { AiModelBadge } from "@/components/AiModelBadge";
import { useServerFn } from "@tanstack/react-start";
import { geocodeAddress } from "@/lib/naver.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { AI_REFUSED_MESSAGE, isAiBlocked, type AiConsent } from "@/lib/ai-consent";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Phone,
  MessageSquare,
  Home,
  Video,
  Users,
  Plus,
  Trash2,
  Pencil,
  FileSpreadsheet,
  Package,
  Search,
  Loader2,
  Check,
  ChevronsUpDown,
  UserRound,
  Sparkles,
  TrendingUp,
  RotateCcw,
  Navigation,
  ClipboardCheck,
  X,
  FileText,
  UploadCloud,
  PenLine,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ClientDialog } from "./ClientDialog";
import { TranscriptViewer } from "./TranscriptViewer";
import { ReassessmentTab } from "./ReassessmentTab";
import { SideDishTab } from "./SideDishTab";
import { MealOpinionTab } from "./MealOpinionTab";
import { FamilyTab } from "./FamilyTab";
import { SideDishAddDialog } from "./SideDishAddDialog";
import { ClosureReportTab } from "./ClosureReportTab";
import { ScopeFilter } from "./ScopeFilter";
import { analyzeNeeds, type NeedsAnalysis } from "@/lib/ai.functions";
import {
  CONTACT_METHODS,
  PROVISION_CATEGORIES,
  NEED_KEYWORDS,
  riskStyle,
  categoryColor,
  daysSince,
  CARE_LEVELS,
  careLevelOf,
  careLevelStyle,
  programsOf,
  programsToType,
  programStyle,
  hasCareLevel,
  matchesScope,
  isTerminated,
  terminatedStyle,
  workerRoster,
  splitNote,
  type Client,
  type ActivityLog,
  type Provision,
  type OrgRow,
  type CarePlanAction,
} from "@/lib/case-types";
import { overrideActionLinks, type CarePlanLinkRow } from "@/lib/care-plan-links";
import { fetchConsentFile, uploadToDrive } from "@/lib/drive";
import { logView } from "@/lib/view-log";
import { useClientViewLog } from "@/lib/use-client-view-log";
import { fetchClosureSummariesByOrg, closureShortLine } from "@/lib/closure-summary";
import { ClosureBanner } from "./ClosureBanner";
import { ConsentViewerDialog } from "@/components/case/ConsentViewerDialog";

// ── 사례관리 계획 달성률 계산 (linkedIds 기반 — 키워드 자동매칭 제거) ──
// ServiceGoalsTab.computeActionResult · OverviewTab.actionRate와 동일 로직
function planActionRate(action: CarePlanAction, linkedLogIds: Set<string>, linkedProvIds: Set<string>): number {
  if (action.manualRate != null) return action.manualRate;
  const linkedIds = new Set([
    ...(action.linkedLogIds ?? []).filter((id) => linkedLogIds.has(id)),
    ...(action.linkedProvIds ?? []).filter((id) => linkedProvIds.has(id)),
  ]);
  const achievedCount = linkedIds.size;
  return action.targetCount
    ? Math.min(100, Math.round((achievedCount / action.targetCount) * 100))
    : Math.min(100, achievedCount * 25);
}

function ContactIcon({ m }: { m: string | null }) {
  const map: Record<string, React.ReactNode> = {
    전화: <Phone className="h-3.5 w-3.5" />,
    방문: <Home className="h-3.5 w-3.5" />,
    문자: <MessageSquare className="h-3.5 w-3.5" />,
    화상: <Video className="h-3.5 w-3.5" />,
    내방: <Users className="h-3.5 w-3.5" />,
  };
  return (
    <>
      {m ? (
        (map[m] ?? <MessageSquare className="h-3.5 w-3.5" />)
      ) : (
        <MessageSquare className="h-3.5 w-3.5 opacity-40" />
      )}
    </>
  );
}

// ── 주민번호 앞자리 파생 (생년월일 "YYYY-MM-DD" → "YYMMDD") ─────────
function birthToRrnFront(birth: string | null | undefined): string | null {
  if (!birth) return null;
  const m = birth.match(/^(\d{2,4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return m[1].slice(-2) + m[2] + m[3];
}

// ── 엑셀 명단 파싱 헬퍼 ─────────────────────────────
function cellStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s && s !== "-" ? s : null;
}
function mapWelfare(v: unknown): string | null {
  const s = v == null ? "" : String(v);
  if (s.includes("수급")) return "수급자";
  if (s.includes("차상위")) return "차상위";
  if (s.includes("긴급")) return "긴급지원";
  return null;
}
function mapHousing(v: unknown): string | null {
  const s = v == null ? "" : String(v).trim();
  if (!s || s === "-") return null;
  const map: Record<string, string> = {
    자가: "자가", 전세: "전세", 월세: "월세", 임대: "임대",
    무상거주: "무상거주", 시설거주: "시설거주",
  };
  return map[s] ?? s;
}
function toBirth(v: unknown): { birth: string | null; rrn: string | null } {
  if (v == null) return { birth: null, rrn: null };
  const digits = String(v).replace(/\D/g, "");
  if (digits.length < 6) return { birth: null, rrn: null };
  const yy = digits.slice(0, 2),
    mm = digits.slice(2, 4),
    dd = digits.slice(4, 6);
  const m = Number(mm),
    d = Number(dd);
  if (m < 1 || m > 12 || d < 1 || d > 31) return { birth: null, rrn: digits.slice(0, 6) };
  const genderDigit = digits.length >= 7 ? Number(digits[6]) : null;
  const century = genderDigit === 3 || genderDigit === 4 ? "20" : "19";
  return { birth: `${century}${yy}-${mm}-${dd}`, rrn: digits.slice(0, 6) };
}
/** 엑셀 시리얼 날짜(숫자) → YYYY-MM-DD. 문자열이면 toBirth로 위임. */
function excelDateToYmd(v: unknown): { birth: string | null; rrn: string | null } {
  if (typeof v === "number" && v > 1000) {
    // Excel epoch: 1899-12-30 기준 (1900년 윤년 버그 포함)
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const yyStr = String(yyyy).slice(2);
    return { birth: `${yyyy}-${mm}-${dd}`, rrn: `${yyStr}${mm}${dd}` };
  }
  return toBirth(v);
}
/**
 * 한국 주소를 기본주소(address)와 상세주소(address_detail)로 분리.
 * - "(법정동) 호수" 형태: 괄호 앞 = 기본주소, 괄호 뒤 = 상세주소
 * - "(법정동, 건물명)" 형태: 건물명 = 상세주소
 * - 괄호 없이 호/층 패턴: 번지 이후 = 상세주소
 * 예) "서울 강남구 예시로21길 19-5  (예시동) B102호" → { address: "서울 강남구 예시로21길 19-5", addressDetail: "B102호" }
 *     "서울 강남구 예시중앙로6길 32  (예시동, 예시빌)" → { address: "서울 강남구 예시중앙로6길 32", addressDetail: "우리빌" }
 */
function splitKoreanAddress(full: string): { address: string; addressDetail: string } {
  const s = full.trim();
  if (!s) return { address: "", addressDetail: "" };

  // ① 괄호 패턴: "(법정동)" 또는 "(법정동, 건물명)"
  const parenMatch = s.match(/^(.*?)\s*\(([^)]+)\)\s*(.*)$/);
  if (parenMatch) {
    const base = parenMatch[1].trim();
    const parenContent = parenMatch[2].trim();
    const afterParen = parenMatch[3].trim();
    if (afterParen) {
      // 괄호 뒤에 호수·층 등이 있으면 그게 상세주소
      return { address: base, addressDetail: afterParen };
    }
    // 괄호 안에 콤마가 있으면 "법정동, 건물명" → 건물명이 상세주소
    const commaIdx = parenContent.indexOf(",");
    if (commaIdx >= 0) {
      const building = parenContent.slice(commaIdx + 1).trim();
      return { address: base, addressDetail: building };
    }
    // 괄호 안이 법정동만 → 상세주소 없음
    return { address: base, addressDetail: "" };
  }

  // ② 괄호 없음: 번지(숫자) 다음에 호·층·동호 패턴
  // e.g. "서울 강남구 예시로21길 19-5 101호"
  const unitMatch = s.match(/^(.*\d)\s+([BCDF-Z가-힣]?[가-힣\d]*(지하|동|호|층)\S*)$/i);
  if (unitMatch) {
    return { address: unitMatch[1].trim(), addressDetail: unitMatch[2].trim() };
  }

  return { address: s, addressDetail: "" };
}

function firstPhone(v: unknown): string | null {
  const s = cellStr(v);
  if (!s) return null;
  const m = s.match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/);
  if (m) return m[0].replace(/\s/g, "");
  return s.split(/[\r\n]+/)[0].trim() || null;
}
function restPhones(v: unknown): string | null {
  const s = cellStr(v);
  if (!s) return null;
  const rest = s
    .split(/[\r\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(1)
    .join(", ");
  return rest || null;
}
type ClientInsertRow = {
  org_id: string;
  name: string;
  type: string;
  risk: string;
  grade: string;
  worker_name: string;
  gender?: string;
  welfare_status?: string;
  housing?: string;
  birth?: string;
  rrn_front?: string;
  address?: string;
  address_detail?: string;
  phone?: string;
  note?: string;
};

type Props = {
  clients: Client[];
  logs: ActivityLog[];
  provisions: Provision[];
  org: OrgRow | null;
  workerName: string;
  onChanged: () => void;
  /** 복순이 모니터링 등 외부에서 특정 대상자를 선택 상태로 포커스할 때 사용 */
  focusClientId?: string | null;
  onFocusConsumed?: () => void;
  canWrite?: boolean;
  planLinks?: CarePlanLinkRow[];
};

export function ClientsTab({ clients, logs, provisions, org, workerName, onChanged, focusClientId, onFocusConsumed, canWrite = true, planLinks = [] }: Props) {
  // 선택 대상자 상태 (페이지 내 in-memory 유지, 새로고침 시 초기화)
  const [selectedId, setSelectedIdState] = useState<string | null>(null);

  // 외부에서 포커스 요청 시 해당 대상자 선택 (다른 탭에서 "이 대상자 보기" 클릭 등)
  useEffect(() => {
    if (focusClientId) {
      setSelectedIdState(focusClientId);
      onFocusConsumed?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusClientId]);

  function setSelectedId(id: string | null) {
    setSelectedIdState(id);
  }

  const [program, setProgram] = useState("전체");
  const [careFilter, setCareFilter] = useState<"전체" | "중점" | "일반">("전체");
  const [workerFilter, setWorkerFilter] = useState("전체");
  const [q, setQ] = useState("");
  const [dlgOpen, setDlgOpen] = useState(false);
  const [editClient, setEditClient] = useState<Client | null>(null);
  const [sideDishDlgOpen, setSideDishDlgOpen] = useState(false);
  const [pdfProgramType, setPdfProgramType] = useState<string>("밑반찬");
  const [trashOpen, setTrashOpen] = useState(false);
  const excelRef = useRef<HTMLInputElement>(null);
  // 엑셀 업로드 전 선택된 사업 (dropdown → hidden input click)
  const excelProgramRef = useRef<string>("사례관리");

  const workers = useMemo(() => workerRoster(clients), [clients]);
  const terminatedClients = useMemo(
    () => clients.filter((c) => isTerminated(c)).sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [clients],
  );

  const activeClients = useMemo(() => clients.filter((c) => !isTerminated(c)), [clients]);

  const programCounts = useMemo(() => {
    const acc: Record<string, number> = { 전체: 0, 사례관리: 0, 밑반찬: 0, 무료급식: 0, 종결: 0 };
    activeClients.forEach((c) => {
      acc.전체++;
      programsOf(c).forEach((p) => { acc[p] = (acc[p] ?? 0) + 1; });
    });
    acc.종결 = terminatedClients.length;
    return acc;
  }, [activeClients, terminatedClients]);

  // 타 사업과 중복 등록된 인원을 사업별로 집계
  // e.g. program="밑반찬" → [{ prog:"사례관리", count:4 }, { prog:"무료급식", count:1 }]
  const overlapByProgram = useMemo(() => {
    const MAIN_PROGRAMS = ["사례관리", "밑반찬", "무료급식"];
    if (!MAIN_PROGRAMS.includes(program)) return [] as { prog: string; count: number }[];
    const acc = new Map<string, number>();
    for (const c of activeClients) {
      const progs = programsOf(c);
      if (!progs.includes(program)) continue;
      progs.filter((p) => p !== program).forEach((other) => {
        acc.set(other, (acc.get(other) ?? 0) + 1);
      });
    }
    return [...acc.entries()]
      .map(([prog, count]) => ({ prog, count }))
      .sort((a, b) => b.count - a.count);
  }, [activeClients, program]);

  // 중복 대상자 이름 목록 (prog → 이름[])
  const overlapClientsByProg = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of activeClients) {
      const progs = programsOf(c);
      if (!progs.includes(program)) continue;
      progs.filter((p) => p !== program).forEach((other) => {
        const arr = map.get(other) ?? [];
        arr.push(c.name);
        map.set(other, arr);
      });
    }
    return map;
  }, [activeClients, program]);

  // 중복제거 체크 기본값 계산 (탭별 상이)
  // - 사례관리/전체: 체크 없음
  // - 밑반찬: 무료급식만 기본 체크
  // - 무료급식: 겹치는 모든 사업 기본 체크 (단, 본인 사업은 제외 대상에서 빠져야 하므로 overlapByProgram 기준)
  function defaultExcludes(prog: string, overlap: { prog: string }[]): Set<string> {
    if (prog === "무료급식") return new Set(overlap.map((o) => o.prog));
    if (prog === "밑반찬") return new Set(overlap.filter((o) => o.prog === "무료급식").map((o) => o.prog));
    return new Set<string>();
  }

  const [excludePrograms, setExcludePrograms] = useState<Set<string>>(new Set());
  const prevProgramRef = useRef(program);
  if (prevProgramRef.current !== program) {
    prevProgramRef.current = program;
    setExcludePrograms(defaultExcludes(program, overlapByProgram));
  }

  const filtered = useMemo(() => {
    const base =
      program === "종결"
        ? terminatedClients.filter((c) => {
            if (workerFilter !== "전체" && (c.worker_name ?? "") !== workerFilter) return false;
            if (q && !matchesClientQuery(c, q)) return false;
            return true;
          })
        : clients
            .filter((c) => {
              if (!matchesScope(c, program, careFilter, workerFilter)) return false;
              if (q && !matchesClientQuery(c, q)) return false;
              // 중복제거: 체크된 사업에 동시 등록된 대상자 제외
              if (excludePrograms.size > 0) {
                const progs = programsOf(c);
                for (const excl of excludePrograms) {
                  if (progs.includes(excl)) return false;
                }
              }
              return true;
            });
    return [...base].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [clients, terminatedClients, program, careFilter, workerFilter, q, excludePrograms]);

  // 종결 모아보기: 각 대상자의 종결일·사유를 목록에 짧게 보여 주기 위해 종결보고 요약을 불러온다
  const [closureInfo, setClosureInfo] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (program !== "종결" || !org?.id) return;
    let cancelled = false;
    fetchClosureSummariesByOrg(org.id).then((m) => {
      if (cancelled) return;
      const next = new Map<string, string>();
      terminatedClients.forEach((c) => next.set(c.id, closureShortLine(m.get(c.id), c.note)));
      setClosureInfo(next);
    });
    return () => {
      cancelled = true;
    };
  }, [program, org?.id, terminatedClients]);

  const selected = selectedId ? (filtered.find((c) => c.id === selectedId) ?? null) : null;
  const selId = selected?.id ?? null;
  useClientViewLog(selected, "대상자관리");
  const selLogs = useMemo(() => logs.filter((l) => l.client_id === selId), [logs, selId]);
  const selProvs = useMemo(
    () => provisions.filter((p) => p.client_id === selId),
    [provisions, selId],
  );

  async function deleteClient(id: string) {
    if (!confirm("삭제하시겠어요? 관련 상담기록·제공이력도 함께 삭제됩니다.")) return;
    const { error } = await supabase.from("clients").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("삭제되었습니다.");
    setSelectedId(null); // 삭제된 대상자 선택 해제
    onChanged();
  }

  // 명단 엑셀 업로드: 모든 시트를 읽어 헤더를 찾고, 양식에 맞게 파싱해 등록.
  // 지원 양식:
  //   A) 사례관리 명단 — '대상자명' 헤더
  //   B) 무료급식 명단 — '이용자명' 헤더 (이용자번호/이용자명/대상구분/학력구분/주거형태/성별/생년월일/주민번호/자택주소1/전화번호1/비고/보호자명1~2/보호자전화1~2/보호자휴대1~2/특이사항)
  async function handleExcelUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !org) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const orgId = org.id;
      const payload: ClientInsertRow[] = [];

      for (const sheetName of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
          header: 1,
          defval: null,
          blankrows: false,
        });

        // ── A) 사례관리 양식: '대상자명' 헤더 ─────────────────────────
        const hIdxA = aoa.findIndex((r) => r.some((c) => cellStr(c) === "대상자명"));
        if (hIdxA >= 0) {
          // 시트 이름으로 담당자를 정하는 규칙은 환경변수(worker-defaults.ts)로 지정, 없으면 로그인한 사용자
          const sheetWorker = workerFromSheetName(sheetName) ?? workerName;
          for (const r of aoa.slice(hIdxA + 1)) {
            const name = cellStr(r[1]);
            if (!name) continue;
            const { birth, rrn } = toBirth(r[5]);
            const address =
              [cellStr(r[6]), cellStr(r[8]) ?? cellStr(r[7]), cellStr(r[9])]
                .filter(Boolean)
                .join(" ") || null;
            const phone = firstPhone(r[10]);
            const extras = [restPhones(r[10]), cellStr(r[11])].filter(Boolean);
            const noteParts = [
              cellStr(r[13]),
              extras.length ? "연락처: " + extras.join(", ") : null,
            ].filter(Boolean);
            const row: ClientInsertRow = {
              org_id: orgId, name, type: "사례관리", risk: "정상", grade: "일반",
              worker_name: cellStr(r[2]) ?? sheetWorker,
            };
            const gender = cellStr(r[4]);
            if (gender === "남" || gender === "여") row.gender = gender;
            const welfare = mapWelfare(r[3]);
            if (welfare) row.welfare_status = welfare;
            if (birth) row.birth = birth;
            if (rrn) row.rrn_front = rrn;
            if (address) row.address = address;
            if (phone) row.phone = phone;
            if (noteParts.length) row.note = noteParts.join("\n");
            payload.push(row);
          }
          continue;
        }

        // ── B) 무료급식 양식: '이용자명' 헤더 ────────────────────────
        // 컬럼: [0]이용자번호 [1]이용자명 [2]대상구분 [3]학력구분 [4]주거형태
        //       [5]성별 [6]생년월일(엑셀시리얼) [7]주민번호 [8]자택주소1
        //       [9]전화번호1 [10]비고 [11]보호자명1 [12]보호자명2
        //       [13]보호자전화1 [14]보호자전화2 [15]보호자휴대1 [16]보호자휴대2 [17]특이사항
        const hIdxB = aoa.findIndex((r) => r.some((c) => cellStr(c) === "이용자명"));
        if (hIdxB >= 0) {
          for (const r of aoa.slice(hIdxB + 1)) {
            const name = cellStr(r[1]);
            if (!name) continue;
            // 생년월일: 엑셀 시리얼(숫자) 또는 문자열 주민번호 앞자리 처리
            const { birth, rrn: rrnFromBirth } = excelDateToYmd(r[6]);
            // 주민번호 앞자리: col[7]에서 추출
            const rrnFull = cellStr(r[7]) ?? "";
            const rrnFront = rrnFull.replace(/\D/g, "").slice(0, 6) || rrnFromBirth || null;
            // 주소: 자택주소1 (col[8]) → 기본주소 + 상세주소 분리
            const { address, addressDetail } = splitKoreanAddress(cellStr(r[8]) ?? "");
            // 전화번호: 자택전화(col[9]) 우선, 없으면 보호자 휴대(col[15])
            const phone = cellStr(r[9]) ?? cellStr(r[15]) ?? null;
            // 보호자 정보 → note에 포함
            const guardianParts: string[] = [];
            const g1 = cellStr(r[11]), g2 = cellStr(r[12]);
            const gp1 = cellStr(r[13]) ?? cellStr(r[15]);
            const gp2 = cellStr(r[14]) ?? cellStr(r[16]);
            if (g1) guardianParts.push(`보호자: ${g1}${gp1 ? " " + gp1 : ""}`);
            if (g2) guardianParts.push(`보호자2: ${g2}${gp2 ? " " + gp2 : ""}`);
            const noteParts = [
              cellStr(r[10]),       // 비고
              cellStr(r[17]),       // 특이사항
              ...guardianParts,
            ].filter(Boolean);
            // 사업 구분: 대상구분(col[2])이 "무료급식"이면 무료급식, 아니면 그대로
            const programCol = cellStr(r[2]) ?? "";
            const type = programCol.includes("무료급식") ? "무료급식" : "무료급식";
            const row: ClientInsertRow = {
              org_id: orgId, name, type, risk: "정상", grade: "일반",
              // 무료급식 기본 담당자: 환경변수로 지정한 사람(없으면 로그인한 사용자)
              worker_name: excelProgramRef.current === "무료급식" ? (programDefaultWorker("무료급식") ?? workerName) : workerName,
            };
            const gender = cellStr(r[5]);
            if (gender === "남" || gender === "여") row.gender = gender;
            const housing = mapHousing(r[4]);
            if (housing) row.housing = housing;
            if (birth) row.birth = birth;
            if (rrnFront) row.rrn_front = rrnFront;
            if (address) row.address = address;
            if (addressDetail) row.address_detail = addressDetail;
            if (phone) row.phone = phone;
            if (noteParts.length) row.note = noteParts.join("\n");
            payload.push(row);
          }
          continue;
        }
      }

      if (payload.length === 0)
        return toast.error(
          "추가할 대상자를 찾지 못했습니다. 사례관리 명단은 '대상자명', 무료급식 명단은 '이용자명' 헤더가 있는지 확인해주세요.",
        );

      // ── 기존 대상자 중복 검사 ─────────────────────────────────────────
      // 동일 이름(+생년월일) 대상자가 이미 있으면:
      //   - 해당 사업이 이미 포함 → 제외(skip)
      //   - 해당 사업이 미포함 → type 컬럼에 사업 추가(UPDATE)
      const toInsert: ClientInsertRow[] = [];
      const toUpdate: { id: string; type: string }[] = [];
      let skipCount = 0;

      for (const row of payload) {
        const newProgram = row.type ?? "사례관리"; // 엑셀에서 파싱된 사업
        const existing = clients.find((c) => {
          if (isTerminated(c)) return false;
          if (c.name !== row.name) return false;
          // 생년월일이 둘 다 있으면 추가 비교
          if (row.birth && c.birth && row.birth !== c.birth) return false;
          return true;
        });

        if (!existing) {
          toInsert.push(row);
        } else {
          const existingPrograms = programsOf(existing);
          if (existingPrograms.includes(newProgram)) {
            skipCount++;          // 이미 해당 사업으로 등록됨 → 제외
          } else {
            // 기존 사업 + 새 사업 병합
            toUpdate.push({
              id: existing.id,
              type: programsToType([...existingPrograms, newProgram]),
            });
          }
        }
      }

      // INSERT (신규)
      if (toInsert.length > 0) {
        const { error } = await supabase.from("clients").insert(toInsert);
        if (error) throw error;
      }
      // UPDATE (사업 추가)
      for (const u of toUpdate) {
        const { error } = await supabase.from("clients").update({ type: u.type }).eq("id", u.id);
        if (error) throw error;
      }

      // 결과 toast
      const parts: string[] = [];
      if (toInsert.length) parts.push(`${toInsert.length}명 신규등록`);
      if (toUpdate.length) parts.push(`${toUpdate.length}명 사업추가`);
      if (skipCount) parts.push(`${skipCount}명 이미등록(제외)`);
      toast.success(parts.join(" · ") || "변경사항 없음");
      onChanged();
      // 원본 엑셀 파일을 Google Drive 대상자관리 폴더에 저장 (실패해도 진행)
      try {
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        await supabase.functions.invoke("drive-proxy", {
          body: { name: file.name, mimeType: file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: btoa(binary), folderName: "대상자관리" },
        });
      } catch {
        // Drive 저장 실패 시 무시
      }
    } catch (err) {
      toast.error("업로드 실패: " + (err as Error).message);
    } finally {
      if (excelRef.current) excelRef.current.value = "";
    }
  }

  return (
    <div className="space-y-4">
      {/* 사업 구분 필터 (사례관리·밑반찬·무료급식) */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex flex-col gap-1.5">
          <ScopeFilter
            program={program}
            onProgram={setProgram}
            care={careFilter}
            onCare={setCareFilter}
            worker={workerFilter}
            onWorker={setWorkerFilter}
            workers={workers}
            counts={programCounts}
          />
          {/* 타 사업 중복 현황 + 중복제거 체크박스 */}
          {overlapByProgram.length > 0 && (
            <div className="flex flex-wrap gap-1.5 items-center">
              {overlapByProgram.map(({ prog, count }) => {
                const checked = excludePrograms.has(prog);
                return (
                  <label
                    key={prog}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] cursor-pointer select-none transition-colors ${
                      checked
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border bg-muted/50 text-muted-foreground hover:bg-muted"
                    }`}
                    title={checked ? `${prog} 중복 대상자 목록에서 제외 중` : `체크 시 ${prog} 중복 대상자 제외`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      className="h-3 w-3 cursor-pointer accent-primary"
                      onChange={(e) =>
                        setExcludePrograms((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(prog);
                          else next.delete(prog);
                          return next;
                        })
                      }
                    />
                    {prog} 중복{" "}
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="underline underline-offset-2 hover:opacity-70"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {count}명
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-36 p-2" align="start">
                        <p className="text-[11px] font-medium mb-1.5 text-muted-foreground">{prog} 중복 대상자</p>
                        <ul className="space-y-0.5">
                          {(overlapClientsByProg.get(prog) ?? []).sort((a, b) => a.localeCompare(b, "ko")).map((name) => (
                            <li key={name} className="text-xs">{name}</li>
                          ))}
                        </ul>
                      </PopoverContent>
                    </Popover>
                    {checked && <span className="opacity-60">(제외)</span>}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 대상자 검색·선택 + 액션 */}
      <div className="flex flex-wrap items-center gap-2">
        <ClientPicker
          clients={filtered}
          selectedId={selId}
          onSelect={setSelectedId}
          onClear={() => setSelectedId(null)}
          query={q}
          onQueryChange={setQ}
          closureInfo={program === "종결" ? closureInfo : undefined}
        />
        <span className="text-xs text-muted-foreground">
          {filtered.length}명{selected ? " · 선택됨" : ""}
        </span>
        <div className="ml-auto flex gap-1 flex-wrap">
          {canWrite && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setTrashOpen(true)}
              title="삭제된 대상자·상담기록 복구"
            >
              <Trash2 className="h-4 w-4" />
              휴지통
            </Button>
          )}
          {canWrite && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" title="엑셀로 대상자 추가">
                    <FileSpreadsheet className="h-4 w-4" />
                    <span className="hidden sm:inline">엑셀</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {(["사례관리", "무료급식"] as const).map((p) => (
                    <DropdownMenuItem
                      key={p}
                      onSelect={() => {
                        excelProgramRef.current = p;
                        excelRef.current?.click();
                      }}
                    >
                      {p} 명단 업로드
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <input
                ref={excelRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={handleExcelUpload}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" title="PDF로 대상자 추가">
                    <Plus className="h-4 w-4" />
                    PDF
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {["밑반찬", "무료급식", "사례관리"].map((p) => (
                    <DropdownMenuItem
                      key={p}
                      onSelect={() => {
                        setPdfProgramType(p);
                        setSideDishDlgOpen(true);
                      }}
                    >
                      {p} 대상자 추가
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                size="sm"
                onClick={() => {
                  setEditClient(null);
                  setDlgOpen(true);
                }}
              >
                <Plus className="h-4 w-4" />
                추가
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 상세 (전체 너비) */}
      {selected ? (
        <Detail
          client={selected}
          logs={selLogs}
          provisions={selProvs}
          workerName={workerName}
          onEdit={() => {
            setEditClient(selected);
            setDlgOpen(true);
          }}
          onDelete={() => deleteClient(selected.id)}
          onChanged={onChanged}
          canWrite={canWrite}
          planLinks={planLinks}
          orgName={org?.name ?? ""}
        />
      ) : (
        <div className="h-[52dvh] lg:h-[60vh] rounded-lg border border-dashed border-border flex flex-col items-center justify-center text-center text-muted-foreground gap-3">
          <div className="relative">
            <UserRound className="h-12 w-12 opacity-20" />
            <Search className="h-5 w-5 opacity-40 absolute -bottom-1 -right-1" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground/50">
              {program === "전체" ? "대상자를 선택해주세요" : `${program} 대상자를 선택해주세요`}
            </p>
            <p className="text-xs">
              {filtered.length === 0
                ? `${program === "전체" ? "" : `${program} `}등록된 대상자가 없습니다. 엑셀이나 추가 버튼으로 등록해보세요.`
                : "검색창에 이름을 입력해 빠르게 찾을 수 있어요."}
            </p>
          </div>
        </div>
      )}

      <ClientDialog
        open={dlgOpen}
        onOpenChange={setDlgOpen}
        client={editClient}
        org={org}
        workerName={workerName}
        workers={workers}
        onSaved={onChanged}
      />
      <SideDishAddDialog
        open={sideDishDlgOpen}
        onOpenChange={setSideDishDlgOpen}
        programType={pdfProgramType}
        org={org}
        workerName={workerName}
        onSaved={onChanged}
      />
      <TrashDialog open={trashOpen} onOpenChange={setTrashOpen} org={org} onRestored={onChanged} />
    </div>
  );
}

// 휴지통: 삭제된 대상자·상담기록을 복구 (audit_log의 DELETE 기록 기반)
function TrashDialog({
  open,
  onOpenChange,
  org,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  org: OrgRow | null;
  onRestored: () => void;
}) {
  const [rows, setRows] = useState<
    {
      id: string;
      table_name: string;
      old_data: Record<string, unknown> | null;
      actor_name: string | null;
      created_at: string;
    }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!org) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("audit_log")
      .select("id,table_name,old_data,actor_name,created_at")
      .eq("org_id", org.id)
      .eq("op", "DELETE")
      .is("reverted_at", null)
      .in("table_name", ["clients", "activity_logs"])
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) setErr(error.message);
    else {
      setErr(null);
      setRows((data as typeof rows) ?? []);
    }
    setLoading(false);
  }, [org]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function restore(id: string) {
    setBusyId(id);
    const { error } = await supabase.rpc("restore_deleted", { _audit_id: id });
    setBusyId(null);
    if (error) return toast.error("복구 실패: " + error.message);
    toast.success("복구되었습니다.");
    await load();
    onRestored();
  }

  const label = (r: { table_name: string; old_data: Record<string, unknown> | null }) => {
    const d = r.old_data ?? {};
    if (r.table_name === "clients") return `대상자 · ${(d.name as string) ?? "-"}`;
    return `상담기록 · ${((d.note as string) ?? "").slice(0, 24) || "(내용 없음)"}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>휴지통</DialogTitle>
          <DialogDescription>
            삭제된 대상자·상담기록을 복구할 수 있어요. (감사 기능이 DB에 반영된 이후의 삭제만
            표시됩니다)
          </DialogDescription>
        </DialogHeader>
        {err && (
          <p className="text-sm text-muted-foreground">
            휴지통을 불러올 수 없습니다. (DB 반영 전이거나 권한 없음)
          </p>
        )}
        {loading && (
          <p className="text-sm text-muted-foreground py-4 text-center">불러오는 중...</p>
        )}
        {!loading && !err && rows.length === 0 && (
          <p className="text-sm text-muted-foreground py-6 text-center">삭제된 항목이 없습니다.</p>
        )}
        <div className="space-y-1.5 max-h-[55vh] overflow-y-auto">
          {rows.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border p-2.5 text-sm"
            >
              <div className="min-w-0">
                <div className="truncate">{label(r)}</div>
                <div className="text-[11px] text-muted-foreground">
                  삭제: {r.actor_name ?? "-"} · {new Date(r.created_at).toLocaleString("ko-KR")}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={busyId === r.id}
                onClick={() => restore(r.id)}
              >
                {busyId === r.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                복구
              </Button>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          ※ 상담기록 복구 시 해당 대상자가 삭제된 상태면, 대상자를 먼저 복구해주세요.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 대상자 검색: 이름·대상자 번호(JN0001, 대소문자 무시)·연락처·주소(상세 포함) */
function matchesClientQuery(c: Client, q: string): boolean {
  if (c.name.includes(q) || (c.phone ?? "").includes(q) || (c.address ?? "").includes(q) || (c.address_detail ?? "").includes(q)) return true;
  const code = (c.client_code ?? "").toLowerCase();
  const kw = q.trim().toLowerCase();
  return !!code && kw !== "" && code.includes(kw);
}

function ClientPicker({
  clients,
  selectedId,
  onSelect,
  onClear,
  query,
  onQueryChange,
  closureInfo,
}: {
  clients: Client[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClear?: () => void;
  query: string;
  onQueryChange: (v: string) => void;
  /** 종결 모아보기에서만 전달: 대상자 id → "종결일 · 사유" */
  closureInfo?: Map<string, string>;
}) {
  const { hidden } = useNameMask();
  const [open, setOpen] = useState(false);
  const selected = clients.find((c) => c.id === selectedId) ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="justify-between min-w-[240px] max-w-full"
        >
          <span className="flex items-center gap-2 truncate">
            <Search className="h-4 w-4 shrink-0 opacity-60" />
            {selected ? (
              <>
                <span className="truncate"><ClientName c={selected} /></span>
                {selected.client_code && !hidden && (
                  <span className="font-mono text-xs text-muted-foreground shrink-0">{selected.client_code}</span>
                )}
                {isTerminated(selected) ? (
                  <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${terminatedStyle}`}>
                    종결
                  </Badge>
                ) : (
                  hasCareLevel(selected) && (
                    <Badge
                      variant="outline"
                      className={`text-[10px] px-1.5 py-0 ${careLevelStyle[careLevelOf(selected)] ?? ""}`}
                    >
                      {careLevelOf(selected)}
                    </Badge>
                  )
                )}
              </>
            ) : (
              <span className="text-muted-foreground">대상자 검색·선택</span>
            )}
          </span>
          {selected && onClear ? (
            <span
              role="button"
              aria-label="선택 취소"
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              className="shrink-0 rounded-sm p-0.5 hover:bg-accent hover:text-foreground text-muted-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          ) : (
            <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-60" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="이름·번호·연락처·주소 검색"
            value={query}
            onValueChange={onQueryChange}
          />
          <CommandList>
            <CommandEmpty>일치하는 대상자가 없습니다.</CommandEmpty>
            <CommandGroup>
              {clients.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.id}
                  onSelect={() => {
                    onSelect(c.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={`mr-2 h-4 w-4 shrink-0 ${selectedId === c.id ? "opacity-100" : "opacity-0"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium truncate"><ClientName c={c} /></span>
                      {isAiBlocked(c) && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-destructive border-destructive/40">
                          {c.ai_consent === "refuse" ? "AI 거부" : "AI 미동의"}
                        </Badge>
                      )}
                      {programsOf(c).map((p) => (
                        <Badge
                          key={p}
                          variant="outline"
                          className={`text-[10px] px-1.5 py-0 ${programStyle[p] ?? ""}`}
                        >
                          {p}
                        </Badge>
                      ))}
                      {isTerminated(c) ? (
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${terminatedStyle}`}>
                          종결
                        </Badge>
                      ) : (
                        hasCareLevel(c) && (
                          <Badge
                            variant="outline"
                            className={`text-[10px] px-1.5 py-0 ${careLevelStyle[careLevelOf(c)] ?? ""}`}
                          >
                            {careLevelOf(c)}
                          </Badge>
                        )
                      )}
                      {/* 무료급식 단독 대상자이면서 종합의견 PDF 미업로드 시 표시 (사례관리 중복은 재사정으로 대체) */}
                      {programsOf(c).includes("무료급식") &&
                        !programsOf(c).includes("사례관리") &&
                        splitNote(c.note).mealOpinion.every((m) => !m.driveUrl) && (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 border-amber-400 text-amber-700 dark:text-amber-400"
                          >
                            종합의견없음
                          </Badge>
                        )}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {c.client_code && !hidden && <span className="font-mono">{c.client_code} · </span>}
                      담당 {c.worker_name ?? "미배정"} · {c.phone ?? "연락처 없음"}
                    </div>
                    {closureInfo?.has(c.id) && (
                      <div className="text-[11px] text-zinc-600 truncate">종결 · {closureInfo.get(c.id)}</div>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function Detail({
  client,
  logs,
  provisions,
  workerName,
  onEdit,
  onDelete,
  onChanged,
  canWrite = true,
  planLinks = [],
  orgName = "",
}: {
  client: Client;
  logs: ActivityLog[];
  provisions: Provision[];
  workerName: string;
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => void;
  canWrite?: boolean;
  planLinks?: CarePlanLinkRow[];
  orgName?: string;
}) {
  const { hidden } = useNameMask();
  // 상세 탭(상담기록·재사정·…·종결보고). 종결 대상자는 종결보고 탭이 기본, 종결 띠의 버튼으로도 이동한다.
  const [detailTab, setDetailTab] = useState<string>(isTerminated(client) ? "closure" : "log");
  const [closureTick, setClosureTick] = useState(0); // 종결보고를 저장하면 올려서 종결 띠를 다시 불러오게 한다
  const tabsRef = useRef<HTMLDivElement>(null);
  function openClosureReport() {
    setDetailTab("closure");
    requestAnimationFrame(() => tabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  // 상담기록 + 제공이력 중 가장 최근 날짜를 최근접촉으로 산출
  // last_contact_at은 DB 자동갱신으로 오늘 날짜가 될 수 있어 오탐 발생 → 폴백으로만 사용
  const effectiveLastContact = useMemo(() => {
    let best: string | null = null;
    logs.forEach((l) => {
      const logDate = toKstDate(l.created_at);
      if (!best || logDate > best) best = logDate;
    });
    provisions.forEach((p) => {
      const provDate = p.provided_at.slice(0, 10);
      if (!best || provDate > best) best = provDate;
    });
    // 상담·제공이력 없는 경우에만 last_contact_at 폴백
    if (!best && client.last_contact_at) best = client.last_contact_at.slice(0, 10);
    return best;
  }, [client.last_contact_at, logs, provisions]);
  const d = daysSince(effectiveLastContact);
  const [logLimit, setLogLimit] = useState(5);
  const [dirBusy, setDirBusy] = useState(false);
  const [localNeeds, setLocalNeeds] = useState<string[]>(client.needs ?? []);
  const [needsBusy, setNeedsBusy] = useState(false);
  const [consentUrl, setConsentUrl] = useState<string | null>(client.consent_drive_url ?? null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentViewBusy, setConsentViewBusy] = useState(false);
  const [consentView, setConsentView] = useState<{ url: string; name: string } | null>(null);
  const [signDialogOpen, setSignDialogOpen] = useState(false);
  const [consentDeleteConfirm, setConsentDeleteConfirm] = useState(false);
  const consentInputRef = useRef<HTMLInputElement>(null);
  const runGeocode = useServerFn(geocodeAddress);

  // client prop 변경 시(다른 대상자 선택) 동의서 URL 동기화
  useEffect(() => { setConsentUrl(client.consent_drive_url ?? null); }, [client.id, client.consent_drive_url]);

  // AI 기능 활용 동의/거부 (미설정·동의는 AI 사용, 거부만 AI에서 제외)
  const [aiConsent, setAiConsent] = useState<AiConsent>((client.ai_consent as AiConsent) ?? "unset");
  const [aiConsentBusy, setAiConsentBusy] = useState(false);
  const [aiRefuseConfirm, setAiRefuseConfirm] = useState(false);
  useEffect(() => {
    setAiConsent((client.ai_consent as AiConsent) ?? "unset");
    setAiRefuseConfirm(false);
  }, [client.id, client.ai_consent]);

  async function saveAiConsent(next: AiConsent) {
    if (aiConsentBusy) return;
    setAiConsentBusy(true);
    setAiRefuseConfirm(false);
    const { data: saved, error } = await supabase
      .from("clients")
      .update({ ai_consent: next })
      .eq("id", client.id)
      .select("id");
    setAiConsentBusy(false);
    if (error || !saved?.length) {
      console.error(error ?? "ai_consent: 갱신된 행 없음(권한 또는 삭제된 대상자)");
      toast.error("AI 활용 설정을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.");
      onChanged();
      return;
    }
    setAiConsent(next);
    toast.success(
      next === "refuse" ? "AI 활용을 거부로 설정했습니다. 이 대상자는 AI 기능에서 제외됩니다."
        : next === "agree" ? "AI 활용 동의로 설정했습니다."
        : "AI 활용 설정을 해제했습니다. (기본: AI 기능 사용)",
    );
    onChanged();
  }

  // 동의서를 올리면(미설정일 때만) 자동으로 '동의'로 표시. 거부는 그대로 둔다.
  async function autoAgreeAfterConsent() {
    if (aiConsent !== "unset") return;
    const { data: updated, error } = await supabase
      .from("clients")
      .update({ ai_consent: "agree" })
      .eq("id", client.id)
      .eq("ai_consent", "unset")
      .select("id");
    if (error) {
      console.warn("[ai_consent] 자동 동의 표시 실패:", error.message);
      return;
    }
    // 그 사이 다른 곳에서 설정이 바뀌어 갱신된 행이 없으면 화면을 바꾸지 않는다(이후 새로고침이 DB 값을 반영)
    if (updated?.length) setAiConsent("agree");
  }

  // 동의서는 Drive에서 비공개라, 앱이 직원의 권한(같은 기관·가입 승인)을 확인한 뒤 대신 열어 준다
  async function viewConsentFile() {
    if (consentViewBusy) return;
    setConsentViewBusy(true);
    try {
      const f = await fetchConsentFile(supabase, client.id);
      logView({ action: "동의서 열람", client });
      setConsentView((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return f;
      });
    } catch (e) {
      console.error("[동의서 보기]", e);
      toast.error("동의서를 열지 못했어요: " + ((e as Error).message || "알 수 없는 오류"));
    } finally {
      setConsentViewBusy(false);
    }
  }
  function closeConsentView() {
    setConsentView((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }

  async function uploadConsentForm(file: File) {
    if (consentBusy) return;
    setConsentBusy(true);
    const tid = toast.loading("동의서 업로드 중...");
    try {
      // 확장자 추출 (없으면 빈 문자열)
      const dotIdx = file.name.lastIndexOf(".");
      const ext = dotIdx !== -1 ? file.name.slice(dotIdx) : "";
      // 한국시간 날짜 (YYYY-MM-DD)
      const dateStr = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const { id, url } = await uploadToDrive(supabase, {
        name: `${client.client_code ?? client.id.slice(0, 8)}_AI기능동의서_${dateStr}${ext}`,
        mimeType: file.type || "application/octet-stream",
        data: btoa(binary),
        folderName: "AI 기능 동의서",
      });
      const { error } = await supabase
        .from("clients")
        .update({ consent_drive_id: id, consent_drive_url: url ?? null })
        .eq("id", client.id);
      if (error) throw error;
      setConsentUrl(url ?? null);
      toast.success("동의서가 저장되었습니다.", { id: tid });
      await autoAgreeAfterConsent();
      onChanged();
    } catch (e) {
      console.error(e);
      toast.error("업로드 실패. 다시 시도해주세요.", { id: tid });
    } finally {
      setConsentBusy(false);
    }
  }

  async function deleteConsentForm() {
    setConsentBusy(true);
    setConsentDeleteConfirm(false);
    const tid = toast.loading("동의서 연결을 해제하는 중...");
    try {
      const { error } = await supabase
        .from("clients")
        .update({ consent_drive_id: null, consent_drive_url: null })
        .eq("id", client.id);
      if (error) throw error;
      setConsentUrl(null);
      toast.success("동의서 연결이 해제되었습니다. (Drive 원본 파일은 보존됩니다)", { id: tid });
      onChanged();
    } catch (e) {
      console.error(e);
      toast.error("해제 실패. 다시 시도해주세요.", { id: tid });
    } finally {
      setConsentBusy(false);
    }
  }

  // client prop 변경 시 로컬 needs 동기화
  useEffect(() => { setLocalNeeds(client.needs ?? []); }, [client.id, client.needs]);

  // 상담기록에서 욕구 키워드 감지 (최근 20개 노트 대상)
  const suggestedNeeds = useMemo(() => {
    const noteText = logs
      .slice(0, 20)
      .map((l) => l.note ?? "")
      .join(" ");
    const found: string[] = [];
    for (const [need, kws] of Object.entries(NEED_KEYWORDS)) {
      if (localNeeds.includes(need)) continue; // 이미 등록된 욕구는 제외
      if (kws.some((kw) => noteText.includes(kw))) found.push(need);
    }
    return found;
  }, [logs, localNeeds]);

  // 욕구 토글 (즉시 DB 저장)
  async function toggleNeed(need: string, add: boolean) {
    if (needsBusy) return;
    setNeedsBusy(true);
    const next = add
      ? [...localNeeds, need]
      : localNeeds.filter((n) => n !== need);
    setLocalNeeds(next);
    try {
      const { data: updated } = await supabase
        .from("clients")
        .update({ needs: next })
        .eq("id", client.id)
        .eq("updated_at", client.updated_at)
        .select("id");
      if (!updated || updated.length === 0) {
        setLocalNeeds(localNeeds); // 롤백
        toast.error("다른 담당자가 방금 수정했습니다. 새로고침 후 다시 시도해주세요.");
        return;
      }
      onChanged();
    } catch {
      setLocalNeeds(localNeeds); // 롤백
      toast.error("욕구 저장 실패");
    } finally {
      setNeedsBusy(false);
    }
  }

  // 길찾기: 주소를 좌표로 변환해 네이버 지도 "길찾기 화면"으로 바로 이동 (현재위치 → 어르신 집).
  // 좌표를 못 구하면(네이버 키 미설정 등) 주소 검색으로 대체하고 안내한다.
  async function openDirections() {
    const addr = client.address?.trim();
    if (!addr) return toast.error("등록된 주소가 없어요.");
    const isMobile =
      typeof navigator !== "undefined" && /iPhone|iPad|Android/i.test(navigator.userAgent);
    setDirBusy(true);
    let geo: { ok: boolean; lat?: number; lng?: number } = { ok: false };
    try {
      geo = await runGeocode({ data: { address: addr } });
    } catch {
      geo = { ok: false };
    }
    setDirBusy(false);

    if (geo.ok && geo.lat != null && geo.lng != null) {
      const dname = encodeURIComponent(`${client.name} 자택`);
      if (isMobile) {
        // 네이버 지도 앱: 출발지 생략 = 현재 위치 → 목적지 (자동차 길찾기)
        const appname = typeof location !== "undefined" ? location.hostname : "app";
        window.location.href = `nmap://route/car?dlat=${geo.lat}&dlng=${geo.lng}&dname=${dname}&appname=${appname}`;
      } else {
        // PC 웹: 네이버 지도 길찾기(출발 내 위치 → 도착 좌표)
        window.open(
          `https://map.naver.com/p/directions/-/${geo.lng},${geo.lat},${dname}/-/car`,
          "_blank",
        );
      }
    } else {
      // 좌표 미확보 → 검색으로 대체 + 안내
      window.open(`https://map.naver.com/p/search/${encodeURIComponent(addr)}`, "_blank");
      toast.info(
        "정확한 경로 안내는 네이버 지도 키(Client ID/Secret) 설정 후 가능해요. 지금은 주소 검색으로 열었어요.",
      );
    }
  }

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-xl"><ClientName c={client} /></CardTitle>
              {client.client_code && !hidden && (
                <Badge variant="secondary" className="font-mono" title="대상자 고유번호 (바뀌지 않는 번호)">
                  {client.client_code}
                </Badge>
              )}
              {isAiBlocked(client) && (
                <Badge variant="outline" className="text-destructive border-destructive/40">{client.ai_consent === "refuse" ? "AI 거부" : "AI 미동의"}</Badge>
              )}
              {programsOf(client).map((p) => (
                <Badge key={p} variant="outline" className={programStyle[p] ?? ""}>
                  {p}
                </Badge>
              ))}
              {isTerminated(client) ? (
                <Badge variant="outline" className={terminatedStyle}>
                  종결
                </Badge>
              ) : (
                hasCareLevel(client) && (
                  <Badge variant="outline" className={careLevelStyle[careLevelOf(client)] ?? ""}>
                    {careLevelOf(client)}
                  </Badge>
                )
              )}
              <Badge variant="outline" className={riskStyle[client.risk] ?? ""}>
                {client.risk}
              </Badge>
              {client.welfare_status && client.welfare_status !== "일반" && (
                <Badge variant="outline" className="border-rose-200 text-rose-700 bg-rose-50">
                  {client.welfare_status}
                </Badge>
              )}
            </div>
            <CardDescription className="mt-1 text-xs">
              {client.gender ?? "-"} · {client.birth ?? "-"} · {client.phone ?? "-"} · 담당{" "}
              {client.worker_name ?? "-"} · 등록 {client.registered_at ?? "-"}
            </CardDescription>
          </div>
          {canWrite && (
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={onEdit}>
                <Pencil className="h-4 w-4" />
                수정
              </Button>
              <Button size="sm" variant="outline" onClick={onDelete}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        <ClosureBanner client={client} tick={closureTick} onOpenReport={openClosureReport} />

        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <div className="rounded-md bg-accent/40 border border-border px-2 py-1.5">
            <div className="text-[10px] text-muted-foreground">전화</div>
            <div className="flex items-center justify-between gap-1">
              <span className="truncate">{client.phone ?? "-"}</span>
              {client.phone?.trim() && (
                <span className="flex items-center gap-1 shrink-0">
                  <a
                    href={`tel:${client.phone.replace(/[^\d+]/g, "")}`}
                    className="inline-flex items-center justify-center h-6 w-6 rounded border border-border bg-background hover:bg-accent text-emerald-600"
                    title="전화 걸기"
                    aria-label="전화 걸기"
                  >
                    <Phone className="h-3.5 w-3.5" />
                  </a>
                  <a
                    href={`sms:${client.phone.replace(/[^\d+]/g, "")}`}
                    className="inline-flex items-center justify-center h-6 w-6 rounded border border-border bg-background hover:bg-accent text-blue-600"
                    title="문자 보내기"
                    aria-label="문자 보내기"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                  </a>
                </span>
              )}
            </div>
          </div>
          <Meta label="담당자" value={client.worker_name ?? "-"} />
          <Meta
            label="주민번호"
            value={`${(client.rrn_front || birthToRrnFront(client.birth)) ?? "------"}-${client.rrn_back1 ?? "*"}******`}
          />
          <Meta label="주거형태" value={client.housing ?? "-"} />
          <Meta label="학력" value={client.education ?? "-"} />
          <div className="col-span-2 md:col-span-4">
            <div className="rounded-md bg-accent/40 border border-border px-2 py-1.5 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] text-muted-foreground">주소</div>
                <div className="truncate">
                  {client.address
                    ? client.address_detail
                      ? `${client.address} ${client.address_detail}`
                      : client.address
                    : "-"}
                </div>
              </div>
              {client.address?.trim() && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0"
                  onClick={openDirections}
                  disabled={dirBusy}
                  title="네이버 지도로 길찾기 (현재 위치 → 어르신 집)"
                >
                  {dirBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Navigation className="h-4 w-4" />
                  )}
                  길찾기
                </Button>
              )}
            </div>
          </div>
          <div className="col-span-2 md:col-span-4 rounded-md bg-accent/40 border border-border px-2 py-1.5">
            <div className="text-[10px] text-muted-foreground">비고</div>
            <div className="whitespace-pre-wrap">
              {splitNote(client.note).note.trim() ? (
                splitNote(client.note).note
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </div>
          </div>
        </div>

        {/* ── AI 기능 동의서 ── */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <input
            ref={consentInputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadConsentForm(f);
              e.target.value = "";
            }}
          />
          {/* 자필 서명 버튼 */}
          {canWrite && (
            <Button
              size="sm"
              variant="outline"
              disabled={consentBusy}
              onClick={() => setSignDialogOpen(true)}
            >
              <PenLine className="h-4 w-4" />
              AI 기능 동의 자필서명
            </Button>
          )}
          {/* 파일 업로드 버튼 (기존) */}
          {canWrite && (
            <Button
              size="sm"
              variant="outline"
              disabled={consentBusy}
              onClick={() => consentInputRef.current?.click()}
            >
              {consentBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UploadCloud className="h-4 w-4" />
              )}
              AI 기능 동의서 업로드
            </Button>
          )}
          {consentUrl && !consentDeleteConfirm && (
            <>
              <button
                type="button"
                disabled={consentViewBusy}
                onClick={viewConsentFile}
                className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2 disabled:opacity-60"
                title="동의서는 비공개로 보관돼서 앱이 권한을 확인한 뒤 열어 드려요."
              >
                {consentViewBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                동의서 보기
              </button>
              {canWrite && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                  disabled={consentBusy}
                  onClick={() => setConsentDeleteConfirm(true)}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  연결 해제
                </Button>
              )}
            </>
          )}
          {canWrite && consentUrl && consentDeleteConfirm && (
            <span className="flex items-center gap-1.5 text-xs text-destructive">
              <span>정말 해제하시겠습니까?</span>
              <Button
                size="sm"
                variant="destructive"
                className="h-6 px-2 text-xs"
                disabled={consentBusy}
                onClick={deleteConsentForm}
              >
                해제
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => setConsentDeleteConfirm(false)}
              >
                취소
              </Button>
            </span>
          )}
        </div>

        {/* 동의서 PDF 보기 (비공개 파일을 앱이 권한 확인 후 대신 보여 줌) */}
        <ConsentViewerDialog url={consentView?.url ?? null} fileName={consentView?.name ?? "AI기능동의서.pdf"} onClose={closeConsentView} />

        {/* 자필 서명 다이얼로그 */}
        <ConsentSignatureDialog
          open={signDialogOpen}
          onOpenChange={setSignDialogOpen}
          clientId={client.id}
          clientName={client.name ?? ""}
          clientCode={client.client_code ?? null}
          orgName={orgName}
          onComplete={(url) => {
            setConsentUrl(url);
            if (aiConsent === "refuse") {
              toast.info("이 대상자는 'AI 기능 활용 거부' 상태입니다. 동의서를 저장했지만 설정은 바뀌지 않았어요. 필요하면 '동의'로 직접 바꿔 주세요.");
            }
            void autoAgreeAfterConsent().then(() => onChanged());
          }}
        />

        {/* ── AI 기능 활용 동의/거부 ── */}
        <div className="mt-2 flex items-center gap-x-4 gap-y-1 flex-wrap text-xs">
          <span className="font-medium text-foreground">AI 기능 활용</span>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <Checkbox
              checked={aiConsent === "agree"}
              disabled={!canWrite || aiConsentBusy}
              onCheckedChange={(v) => saveAiConsent(v ? "agree" : "unset")}
            />
            동의
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <Checkbox
              checked={aiConsent === "refuse"}
              disabled={!canWrite || aiConsentBusy}
              onCheckedChange={(v) => (v ? setAiRefuseConfirm(true) : saveAiConsent("unset"))}
            />
            <span className={aiConsent === "refuse" ? "text-destructive font-medium" : ""}>거부</span>
          </label>
          <span className="text-muted-foreground">
            {aiConsent === "refuse"
              ? "이 대상자는 AI 기능에서 제외됩니다."
              : aiConsent === "agree"
                ? "이 대상자는 AI 기능을 사용합니다."
                : "동의하기 전에는 AI 기능에서 제외됩니다."}
          </span>
        </div>
        {canWrite && aiRefuseConfirm && (
          <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs space-y-2">
            <p>
              AI 활용을 <b>거부</b>하면 이 대상자의 정보는 AI 분석·추천·다듬기·녹음 전사에서 제외됩니다.
              이미 만들어진 AI 리포트에는 내용이 남아 있을 수 있고, 이미 구글로 전송된 데이터는 되돌릴 수 없습니다.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" onClick={() => saveAiConsent("refuse")}>
                거부로 설정
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setAiRefuseConfirm(false)}>
                취소
              </Button>
            </div>
          </div>
        )}

        {/* ── 욕구 태그 (항상 표시) ── */}
        <div className="mt-3">
          <div className="flex flex-wrap gap-1.5">
            {localNeeds.map((n) => (
              <button
                key={n}
                title={canWrite ? "클릭하면 욕구에서 제거" : undefined}
                disabled={needsBusy || !canWrite}
                onClick={() => canWrite && toggleNeed(n, false)}
                className="text-xs bg-primary/10 text-primary border border-primary/30 rounded-full px-2.5 py-0.5 hover:bg-red-50 hover:border-red-300 hover:text-red-600 transition-colors disabled:opacity-50 disabled:cursor-default"
              >
                {canWrite ? `#${n} ✕` : `#${n}`}
              </button>
            ))}
            {canWrite && suggestedNeeds.map((n) => (
              <button
                key={n}
                title="상담기록에서 감지된 욕구 — 클릭하면 추가"
                disabled={needsBusy}
                onClick={() => toggleNeed(n, true)}
                className="text-xs border border-dashed border-amber-400 text-amber-700 bg-amber-50 rounded-full px-2.5 py-0.5 hover:bg-amber-100 transition-colors disabled:opacity-50"
              >
                + {n}
              </button>
            ))}
            {localNeeds.length === 0 && suggestedNeeds.length === 0 && (
              <span className="text-xs text-muted-foreground">등록된 욕구 없음 · 수정 버튼에서 추가하세요</span>
            )}
          </div>
          {suggestedNeeds.length > 0 && (
            <p className="text-[10px] text-amber-600 mt-1">
              💡 상담기록에서 감지된 욕구 — 노란 항목을 클릭하면 즉시 추가됩니다
            </p>
          )}
        </div>
        <div className="mt-2 text-xs text-muted-foreground flex items-center gap-2">
          <ContactIcon m={client.last_contact_method} />
          {client.last_contact_method ?? "접촉 기록 없음"}{" "}
          {d != null && <span className={d >= 14 ? "text-orange-600" : ""}>· {d}일 전</span>}
        </div>
      </CardHeader>

      <CardContent>
        {/* 사업 유형별 탭 구성
            - 무료급식 전용: 상담기록 · 종합의견 · 제공이력 · 분석
            - 밑반찬 전용: 상담기록 · 실태조사 · 제공이력 · 분석
            - 그 외(사례관리 포함): 상담기록 · 재사정 · 제공이력 · 분석 */}
        {(() => {
          const progs = programsOf(client);
          const isSideDishOnly = progs.includes("밑반찬") && !progs.includes("사례관리");
          const isFreeOnly = progs.includes("무료급식") && !progs.includes("사례관리") && !progs.includes("밑반찬");
          const tab2Label = isFreeOnly ? "종합의견" : isSideDishOnly ? "실태조사" : "재사정";
          const showClosure = client.grade === "종결";
          // 종결 탭이 있으면 6열, 없으면 5열
          const colClass = showClosure
            ? "grid-cols-3 sm:grid-cols-6"
            : "grid-cols-3 sm:grid-cols-5";
          return (
        <div ref={tabsRef} className="scroll-mt-2">
        <Tabs
          value={detailTab === "closure" && !showClosure ? "log" : detailTab}
          onValueChange={setDetailTab}
        >
          <TabsList className={`grid w-full h-auto ${colClass}`}>
            <TabsTrigger value="log">
              <MessageSquare className="h-4 w-4 mr-1" />
              상담기록
            </TabsTrigger>
            <TabsTrigger value="reassess">
              <ClipboardCheck className="h-4 w-4 mr-1" />
              {tab2Label}
            </TabsTrigger>
            <TabsTrigger value="prov">
              <Package className="h-4 w-4 mr-1" />
              제공 이력
            </TabsTrigger>
            <TabsTrigger value="family">
              <Users className="h-4 w-4 mr-1" />
              가족관계
            </TabsTrigger>
            <TabsTrigger value="ai">
              <TrendingUp className="h-4 w-4 mr-1" />
              분석
            </TabsTrigger>
            {showClosure && (
              <TabsTrigger value="closure">
                <FileText className="h-4 w-4 mr-1" />
                종결보고
              </TabsTrigger>
            )}
          </TabsList>

          {showClosure && (
            <TabsContent value="closure" className="mt-4">
              <ClosureReportTab
                key={client.id}
                client={client}
                onChanged={() => {
                  onChanged();
                  setClosureTick((t) => t + 1);
                }}
              />
            </TabsContent>
          )}

          <TabsContent value="reassess" className="mt-4">
            {isFreeOnly ? (
              <MealOpinionTab client={client} onChanged={onChanged} />
            ) : isSideDishOnly ? (
              <SideDishTab client={client} onChanged={onChanged} />
            ) : (
              <ReassessmentTab client={client} onChanged={onChanged} />
            )}
          </TabsContent>

          <TabsContent value="log" className="mt-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-xs text-muted-foreground">
                읽기 전용 · 추가·수정·삭제는 <b>[상담]</b> 탭에서 하세요.
              </p>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">표시 개수</span>
                <Select value={String(logLimit)} onValueChange={(v) => setLogLimit(Number(v))}>
                  <SelectTrigger className="h-8 w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5">5개</SelectItem>
                    <SelectItem value="10">10개</SelectItem>
                    <SelectItem value="20">20개</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2 max-h-[380px] overflow-y-auto">
              {logs.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  상담기록이 없습니다.
                </p>
              )}
              {logs.slice(0, logLimit).map((l) => (
                <div key={l.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                    <span className="inline-flex items-center gap-1">
                      <ContactIcon m={l.method} />
                      {l.method} · {l.worker_name ?? "-"}
                    </span>
                    <span>{formatLogDateTime(l)}</span>
                  </div>
                  {l.title && (
                    <p className="font-semibold text-sm mb-1">{l.title}</p>
                  )}
                  <p className="whitespace-pre-wrap">{l.note}</p>
                  {l.result && (
                    <div className="mt-2 rounded-md bg-muted/50 px-3 py-2">
                      <p className="text-xs text-muted-foreground mb-0.5">결과내용 (진단 및 대처)</p>
                      <p className="text-sm whitespace-pre-wrap">{l.result}</p>
                    </div>
                  )}
                  {l.transcript && (
                    <TranscriptViewer logId={l.id} transcript={l.transcript} aiBlocked={isAiBlocked(client)} clientId={client.id} />
                  )}
                </div>
              ))}
              {logs.length > logLimit && (
                <p className="text-center text-xs text-muted-foreground pt-1">
                  전체 {logs.length}건 중 최근 {logLimit}건 표시 · 더 보려면 표시 개수를 늘리세요
                </p>
              )}
            </div>
          </TabsContent>

          <TabsContent value="prov" className="mt-4 space-y-3">
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Package className="h-3.5 w-3.5 shrink-0" />
              제공이력 등록·수정은 <strong>[상담 및 제공이력]</strong> 탭에서 할 수 있습니다.
            </p>
            <div className="space-y-2 max-h-[360px] overflow-y-auto">
              {provisions.length === 0 && (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  등록된 제공이력이 없습니다.
                </p>
              )}
              {[...provisions]
                .sort((a, b) => b.provided_at.localeCompare(a.provided_at))
                .map((p) => (
                  <div
                    key={p.id}
                    className="rounded-md border border-border p-3 text-sm"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={categoryColor[p.category] ?? ""}>
                        {p.category}
                      </Badge>
                      <span className="font-medium">{p.title}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {p.quantity && <>{p.quantity} · </>}
                      {p.agency ?? "자체"} · {p.provided_at}
                    </div>
                    {p.note && <p className="text-xs mt-1 text-muted-foreground">{p.note}</p>}
                  </div>
                ))}
            </div>
          </TabsContent>

          <TabsContent value="family" className="mt-4">
            <FamilyTab client={client} onChanged={onChanged} />
          </TabsContent>

          <TabsContent value="ai" className="mt-4">
            <AiAnalysisPanel client={client} logs={logs} provisions={provisions} planLinks={planLinks} />
          </TabsContent>
        </Tabs>
        </div>
          );
        })()}
      </CardContent>
    </Card>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-accent/40 border border-border px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="truncate">{value}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-accent/30 px-3 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

/** 대상자별 AI 분석: 정량 지표는 자동 계산, 정성 분석은 버튼을 눌렀을 때만 AI 호출.
 *  결과는 localStorage에 캐시 → 탭 이동/새로고침 후에도 유지, 재분석 버튼으로만 갱신. */
function AiAnalysisPanel({
  client,
  logs,
  provisions,
  planLinks = [],
}: {
  client: Client;
  logs: ActivityLog[];
  provisions: Provision[];
  planLinks?: CarePlanLinkRow[];
}) {
  const cacheKey = `ai_analysis_v1_${client.id}`;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<NeedsAnalysis | null>(null);
  const [analyzedAt, setAnalyzedAt] = useState("");
  const runAnalyze = useServerFn(analyzeNeeds);

  // 마운트 시 캐시 로드
  useEffect(() => {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const { result: cached, analyzedAt: at } = JSON.parse(raw) as {
          result: NeedsAnalysis;
          analyzedAt: string;
        };
        setResult(cached);
        setAnalyzedAt(at);
      } else {
        setResult(null);
        setAnalyzedAt("");
      }
    } catch {
      setResult(null);
    }
  }, [client.id]);

  // 정성 분석: 제미나이로 서술형 욕구 분석 (키 없으면 안내)
  async function run() {
    if (isAiBlocked(client)) {
      toast.error(AI_REFUSED_MESSAGE);
      return;
    }
    setBusy(true);
    try {
      const r = await runAnalyze({ data: { clientId: client.id } });
      if (r.ok) {
        const at = new Date().toISOString();
        localStorage.setItem(cacheKey, JSON.stringify({ result: r, analyzedAt: at }));
        setResult(r);
        setAnalyzedAt(at);
        toast.success("분석 완료 — 저장됐습니다.");
      } else {
        if (r.message) toast.message(r.message);
      }
    } catch (e) {
      const msg = (e as Error).message || "";
      if (/GEMINI_API_KEY missing/.test(msg)) {
        toast.message(
          "제미나이 키가 설정되면 AI 정성 분석을 사용할 수 있어요. 정량 지표는 항상 제공됩니다.",
        );
      } else {
        toast.error("분석 실패: " + msg);
      }
    }
    setBusy(false);
  }

  const methodCounts = useMemo(() => {
    const m: Record<string, number> = {};
    logs.forEach((l) => {
      const k = l.method ?? "기타";
      m[k] = (m[k] ?? 0) + 1;
    });
    return m;
  }, [logs]);
  const provCounts = useMemo(() => {
    const m: Record<string, number> = {};
    provisions.forEach((p) => {
      m[p.category] = (m[p.category] ?? 0) + 1;
    });
    return m;
  }, [provisions]);
  // 상담기록 + 제공이력 중 가장 최근 날짜를 최근접촉으로 산출
  // last_contact_at은 DB 자동갱신으로 오늘 날짜가 될 수 있어 오탐 발생 → 폴백으로만 사용
  const effectiveLastContact = useMemo(() => {
    let best: string | null = null;
    logs.forEach((l) => {
      const logDate = toKstDate(l.created_at);
      if (!best || logDate > best) best = logDate;
    });
    provisions.forEach((p) => {
      const provDate = p.provided_at.slice(0, 10);
      if (!best || provDate > best) best = provDate;
    });
    // 상담·제공이력 없는 경우에만 last_contact_at 폴백
    if (!best && client.last_contact_at) best = client.last_contact_at.slice(0, 10);
    return best;
  }, [client.last_contact_at, logs, provisions]);
  const lastDays = daysSince(effectiveLastContact);

  // 사례관리 계획점검(ServiceGoalsTab)과 동일 로직으로 달성률 산출 — linkedIds 기반
  const currentYear = new Date().getFullYear();
  const planRate = useMemo(() => {
    const { reassessments } = splitNote(client.note);
    const plan = reassessments.find((r) => Number(r.carePlan?.year) === currentYear)?.carePlan;
    if (!plan || !plan.rows.length) return null;
    const yearLogIds = new Set(
      logs.filter((l) => toKstDate(l.created_at).startsWith(String(currentYear))).map((l) => l.id),
    );
    const yearProvIds = new Set(
      provisions.filter((p) => p.provided_at.startsWith(String(currentYear))).map((p) => p.id),
    );
    // care_plan_action_links 테이블 데이터로 action의 linked* 필드 오버라이드
    const clientYearLinks = planLinks.filter(
      (l) => l.client_id === client.id && l.plan_year === currentYear,
    );
    const rowRates = plan.rows.map((row) => {
      const baseActions = [...row.selfPlan, ...row.workerPlan];
      const actions = overrideActionLinks(baseActions, clientYearLinks);
      if (actions.length === 0) return 0;
      const s = actions.reduce((acc, a) => acc + planActionRate(a, yearLogIds, yearProvIds), 0);
      return Math.round(s / actions.length);
    });
    return Math.round(rowRates.reduce((acc, r) => acc + r, 0) / rowRates.length);
  }, [client.note, client.id, logs, provisions, currentYear, planLinks]);

  return (
    <div className="space-y-4">
      {/* 정량 지표 (자동 계산) */}
      <div>
        <div className="flex items-center gap-1.5 text-sm font-medium mb-2">
          <TrendingUp className="h-4 w-4" /> 정량 지표
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="상담 횟수" value={`${logs.length}회`} />
          <Stat label="최근 접촉" value={lastDays != null ? `${lastDays}일 전` : "기록 없음"} />
          <Stat label="제공 이력" value={`${provisions.length}건`} />
          <Stat label="목표 달성률" value={planRate != null ? `${planRate}%` : "계획 없음"} />
        </div>
        {(Object.keys(methodCounts).length > 0 || Object.keys(provCounts).length > 0) && (
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
            {Object.entries(methodCounts).map(([k, v]) => (
              <span key={`m-${k}`} className="rounded-full bg-secondary px-2 py-0.5">
                {k} {v}
              </span>
            ))}
            {Object.entries(provCounts).map(([k, v]) => (
              <span key={`p-${k}`} className="rounded-full border border-border px-2 py-0.5">
                {k} {v}
              </span>
            ))}
          </div>
        )}
        {client.needs?.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {client.needs.map((n) => (
              <span
                key={n}
                className="text-xs bg-secondary text-secondary-foreground rounded-full px-2.5 py-0.5"
              >
                #{n}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 정성 분석 (AI · 제미나이) */}
      <div className="border-t border-border pt-3">
        <div className="flex items-center justify-between gap-2 mb-2 flex-wrap gap-y-1">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-primary" /> 정성 분석 (AI)
            <AiModelBadge />
            {analyzedAt && (
              <span className="text-[10px] font-normal text-muted-foreground">
                분석일 {new Date(analyzedAt).toLocaleDateString("ko-KR")}
              </span>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {result ? "재분석" : "AI 분석"}
          </Button>
        </div>

        {!result && !busy && (
          <p className="text-xs text-muted-foreground">
            상담기록·제공이력·욕구를 근거로 서술형 욕구 분석과 우선 지원 제안을 제공합니다.
            (제미나이 키가 없으면 위 정량 지표만 사용)
          </p>
        )}

        {result?.ok && (
          <div className="space-y-3">
            {result.needs.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {result.needs.map((n) => (
                  <span
                    key={n}
                    className="text-xs rounded-full border border-primary/40 bg-primary/5 text-primary px-2.5 py-0.5"
                  >
                    {n}
                  </span>
                ))}
              </div>
            )}
            {result.report && (
              <p className="text-sm whitespace-pre-wrap leading-relaxed">{result.report}</p>
            )}
            {result.priorities.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">우선 지원 제안</div>
                <ul className="list-disc pl-5 space-y-0.5 text-sm">
                  {result.priorities.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
