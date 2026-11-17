import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { formatLogDateTime } from "@/lib/log-time";
import { Download, Filter, FileText, Package } from "lucide-react";
import {
  categoryColor,
  careLevelOf,
  workerRoster,
  type Client,
  type ActivityLog,
  type Provision,
} from "@/lib/case-types";

type Props = { clients: Client[]; logs: ActivityLog[]; provisions: Provision[] };

export function ActivityLogsTab({ clients, logs, provisions }: Props) {
  const [tab, setTab] = useState<"log" | "prov">("log");
  const [clientId, setClientId] = useState<string>("all");
  const [category, setCategory] = useState<string>("all");
  const [method, setMethod] = useState<string>("all");
  const [careFilter, setCareFilter] = useState<"전체" | "중점" | "일반">("전체");
  const [workerFilter, setWorkerFilter] = useState("전체");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const workers = useMemo(() => workerRoster(clients), [clients]);
  const nameOf = (id: string) => clientById.get(id)?.name ?? "-";
  const typeOf = (id: string) => clientById.get(id)?.type ?? "-";

  const inRange = (iso: string) => {
    const t = new Date(iso).getTime();
    if (from && t < new Date(from + "T00:00:00").getTime()) return false;
    if (to && t > new Date(to + "T23:59:59").getTime()) return false;
    return true;
  };
  // 대상자의 사례관리 구분·담당자로 필터 (기록이 속한 대상자 기준)
  const matchClient = (id: string) => {
    const c = clientById.get(id);
    if (careFilter !== "전체" && (!c || careLevelOf(c) !== careFilter)) return false;
    if (workerFilter !== "전체" && (c?.worker_name ?? "") !== workerFilter) return false;
    return true;
  };

  const fLogs = useMemo(
    () =>
      logs.filter((l) => {
        if (clientId !== "all" && l.client_id !== clientId) return false;
        if (method !== "all" && l.method !== method) return false;
        if (!matchClient(l.client_id)) return false;
        if (!inRange(l.created_at)) return false;
        return true;
      }),
    [logs, clientId, method, careFilter, workerFilter, from, to],
  );

  const fProv = useMemo(
    () =>
      provisions.filter((p) => {
        if (clientId !== "all" && p.client_id !== clientId) return false;
        if (category !== "all" && p.category !== category) return false;
        if (!matchClient(p.client_id)) return false;
        if (!inRange(p.provided_at)) return false;
        return true;
      }),
    [provisions, clientId, category, careFilter, workerFilter, from, to],
  );

  function exportLogs() {
    if (fLogs.length === 0) return toast.error("내보낼 상담기록이 없습니다.");
    const rows = fLogs.map((l) => ({
      일시: formatLogDateTime(l),
      대상자: nameOf(l.client_id),
      유형: typeOf(l.client_id),
      접촉방법: l.method,
      담당자: l.worker_name ?? "",
      내용: l.note,
      원문: l.transcript ?? "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "상담기록");
    XLSX.writeFile(wb, `상담기록_${from || "전체"}_${to || "전체"}.xlsx`);
    toast.success("엑셀 파일로 저장되었습니다.");
  }

  function exportProv() {
    if (fProv.length === 0) return toast.error("내보낼 제공이력이 없습니다.");
    const rows = fProv.map((p) => ({
      제공일: p.provided_at,
      대상자: nameOf(p.client_id),
      분류: p.category,
      항목: p.title,
      수량: p.quantity ?? "",
      제공기관: p.agency ?? "",
      비고: p.note ?? "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "제공이력");
    XLSX.writeFile(wb, `제공이력_${from || "전체"}_${to || "전체"}.xlsx`);
    toast.success("엑셀 파일로 저장되었습니다.");
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Filter className="h-4 w-4" />
            활동 로그 필터
          </CardTitle>
          <CardDescription>
            구분·담당자·기간·분류로 필터링한 뒤 엑셀로 내려받을 수 있습니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {(["전체", "중점", "일반"] as const).map((lv) => (
              <Button
                key={lv}
                size="sm"
                variant={careFilter === lv ? "default" : "outline"}
                onClick={() => setCareFilter(lv)}
              >
                {lv === "전체" ? "전체 구분" : lv}
              </Button>
            ))}
            <div className="h-5 w-px bg-border mx-1" />
            <span className="text-xs text-muted-foreground">담당자</span>
            <Select value={workerFilter} onValueChange={setWorkerFilter}>
              <SelectTrigger className="h-8 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="전체">전체 담당자</SelectItem>
                {workers.map((w) => (
                  <SelectItem key={w} value={w}>
                    {w}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">대상자</Label>
              <Select value={clientId} onValueChange={setClientId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">전체</SelectItem>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">시작일</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">종료일</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            {tab === "log" ? (
              <div className="space-y-1">
                <Label className="text-xs">접촉방법</Label>
                <Select value={method} onValueChange={setMethod}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">전체</SelectItem>
                    {["전화", "방문", "문자", "내방"].map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-1">
                <Label className="text-xs">분류</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">전체</SelectItem>
                    {["후원물품", "서비스", "프로그램", "현물지원", "현금지원", "기타"].map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="col-span-2 md:col-span-2 flex items-end gap-2">
              <Button
                variant={tab === "log" ? "default" : "outline"}
                size="sm"
                onClick={() => setTab("log")}
              >
                <FileText className="h-4 w-4" />
                상담기록
              </Button>
              <Button
                variant={tab === "prov" ? "default" : "outline"}
                size="sm"
                onClick={() => setTab("prov")}
              >
                <Package className="h-4 w-4" />
                제공이력
              </Button>
              <Button
                size="sm"
                onClick={tab === "log" ? exportLogs : exportProv}
                className="ml-auto"
              >
                <Download className="h-4 w-4" />
                엑셀 다운로드
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {tab === "log" ? `상담기록 (${fLogs.length})` : `제공이력 (${fProv.length})`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tab === "log" ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b">
                  <tr className="text-left">
                    <th className="py-2 pr-3">일시</th>
                    <th className="py-2 pr-3">대상자</th>
                    <th className="py-2 pr-3">방법</th>
                    <th className="py-2 pr-3">담당자</th>
                    <th className="py-2">내용</th>
                  </tr>
                </thead>
                <tbody>
                  {fLogs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-muted-foreground">
                        기록이 없습니다.
                      </td>
                    </tr>
                  )}
                  {fLogs.map((l) => (
                    <tr key={l.id} className="border-b border-border last:border-0 align-top">
                      <td className="py-2 pr-3 whitespace-nowrap text-xs">
                        {formatLogDateTime(l)}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">{nameOf(l.client_id)}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <Badge variant="secondary">{l.method}</Badge>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap text-xs">
                        {l.worker_name ?? "-"}
                      </td>
                      <td className="py-2 max-w-md">
                        <p className="line-clamp-3 whitespace-pre-wrap">{l.note}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b">
                  <tr className="text-left">
                    <th className="py-2 pr-3">제공일</th>
                    <th className="py-2 pr-3">대상자</th>
                    <th className="py-2 pr-3">분류</th>
                    <th className="py-2 pr-3">항목</th>
                    <th className="py-2 pr-3">수량</th>
                    <th className="py-2">제공기관</th>
                  </tr>
                </thead>
                <tbody>
                  {fProv.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-muted-foreground">
                        기록이 없습니다.
                      </td>
                    </tr>
                  )}
                  {fProv.map((p) => (
                    <tr key={p.id} className="border-b border-border last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap">{p.provided_at}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{nameOf(p.client_id)}</td>
                      <td className="py-2 pr-3">
                        <Badge variant="outline" className={categoryColor[p.category] ?? ""}>
                          {p.category}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3">{p.title}</td>
                      <td className="py-2 pr-3 text-xs">{p.quantity ?? "-"}</td>
                      <td className="py-2 text-xs">{p.agency ?? "자체"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
