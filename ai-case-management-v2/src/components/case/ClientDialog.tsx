import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "sonner";
import { ChevronDown, Plus, X, Pencil, Network, Search } from "lucide-react";
import { GenogramEditor } from "./GenogramEditor";
import { openAddressSearch } from "@/lib/daum-postcode";
import {
  RISK_LEVELS,
  HOUSING_TYPES,
  HOUSEHOLD_TYPES,
  EDUCATION_TYPES,
  GENDER_TYPES,
  WELFARE_STATUS,
  CARE_LEVELS,
  CLOSE_REASONS,
  NEED_PRESETS,
  careLevelOf,
  isTerminated,
  splitNote,
  joinNote,
  PROGRAMS,
  programsOf,
  programsToType,
  type Client,
  type OrgRow,
} from "@/lib/case-types";

/** 구글 Drive URL을 <img src>에서 안정적으로 로드되는 형식으로 변환.
 *  uc?export=view 형식은 구글이 차단 → thumbnail API로 교체. */
function toGenogramDisplayUrl(url: string): string {
  if (!url || url.startsWith("data:")) return url;
  // 구 형식: .../uc?export=view&id=ID  또는  .../uc?id=ID&export=view
  const idMatch = url.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (idMatch && url.includes("drive.google.com/uc")) {
    return `https://drive.google.com/thumbnail?id=${idMatch[1]}&sz=w1600`;
  }
  return url;
}

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  client: Client | null;
  org: OrgRow | null;
  workerName: string;
  workers: string[];
  onSaved: () => void;
};

const DIRECT = "__direct__";

const empty = (workerName: string, type: string) => ({
  name: "",
  registered_at: new Date().toISOString().slice(0, 10),
  rrn_front: "",
  rrn_back1: "",
  birth: "",
  gender: "여",
  phone: "",
  address: "",
  housing: "",
  household: "",  // 동거형태
  education: "무학",
  welfare_status: "일반",
  type,
  care_level: "일반",
  risk: "정상",
  needs: [] as string[],
  progress: 0,
  note: "",
  worker_name: workerName,
  genogram: "" as string,
  closeReason: "", // 종결 사유
});

export function ClientDialog({
  open,
  onOpenChange,
  client,
  org,
  workerName,
  workers,
  onSaved,
}: Props) {
  const [form, setForm] = useState(empty(workerName, "사례관리"));
  const [saving, setSaving] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [needInput, setNeedInput] = useState("");
  const [workerDirect, setWorkerDirect] = useState(false);
  const [genoOpen, setGenoOpen] = useState(false);
  const [addressDetail, setAddressDetail] = useState(""); // 상세주소(별도 컬럼)
  const [dupNames, setDupNames] = useState<string[]>([]); // 동명 대상자 목록
  const dupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 이름 입력 시 동명 대상자 자동 조회 (debounce 500ms, 신규 등록 시에만)
  useEffect(() => {
    if (client) return; // 수정 모드에서는 체크 안 함
    const name = form.name.trim();
    if (dupTimerRef.current) clearTimeout(dupTimerRef.current);
    if (!name || !org) { setDupNames([]); return; }
    dupTimerRef.current = setTimeout(async () => {
      const { data } = await supabase
        .from("clients")
        .select("name")
        .eq("org_id", org.id)
        .eq("name", name);
      setDupNames((data ?? []).map((r) => r.name));
    }, 500);
    return () => { if (dupTimerRef.current) clearTimeout(dupTimerRef.current); };
  }, [form.name, client, org]);

  useEffect(() => {
    if (!open) return;
    setDetailOpen(false);
    setNeedInput("");
    setWorkerDirect(false);
    setDupNames([]);
    if (client) {
      // address_detail 컬럼이 있으면 사용, 없으면 ""
      setAddressDetail(client.address_detail ?? ""); // Fix #7: Client 타입에 address_detail 추가됐으므로 cast 불필요
      setForm({
        name: client.name,
        registered_at: client.registered_at ?? new Date().toISOString().slice(0, 10),
        rrn_front: client.rrn_front ?? "",
        rrn_back1: client.rrn_back1 ?? "",
        birth: client.birth ?? "",
        gender: client.gender ?? "여",
        phone: client.phone ?? "",
        address: client.address ?? "",
        housing: client.housing ?? "",
        household: (client as unknown as Record<string, unknown>).household as string ?? "",
        education: client.education ?? "무학",
        welfare_status: client.welfare_status ?? "일반",
        type: client.type,
        care_level: isTerminated(client) ? "종결" : careLevelOf(client),
        risk: client.risk,
        needs: client.needs ?? [],
        progress: client.progress,
        note: splitNote(client.note).note,
        worker_name: client.worker_name ?? workerName,
        genogram: client.genogram ?? "",
        closeReason: splitNote(client.note).closeReason ?? "",
      });
    } else {
      setAddressDetail("");
      setForm(empty(workerName, "사례관리"));
    }
  }, [client, org, workerName, open]);

  function upd<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // 사업 구분(다중) — type 컬럼에 콤마로 저장
  const programs = programsOf({ type: form.type });
  const toggleProgram = (p: string) => {
    const next = programs.includes(p) ? programs.filter((x) => x !== p) : [...programs, p];
    upd("type", programsToType(next));
  };

  function rrnToBirth(front: string, back1: string): string {
    if (front.length !== 6 || !/^\d{6}$/.test(front)) return "";
    const yy = front.slice(0, 2);
    const mm = front.slice(2, 4);
    const dd = front.slice(4, 6);
    let century = "";
    if (["1", "2", "5", "6"].includes(back1)) century = "19";
    else if (["3", "4", "7", "8"].includes(back1)) century = "20";
    else if (["9", "0"].includes(back1)) century = "18";
    else century = Number(yy) > 25 ? "19" : "20";
    const m = Number(mm),
      d = Number(dd);
    if (m < 1 || m > 12 || d < 1 || d > 31) return "";
    return `${century}${yy}-${mm}-${dd}`;
  }

  function updRrnFront(v: string) {
    const clean = v.replace(/\D/g, "").slice(0, 6);
    setForm((f) => {
      const birth = rrnToBirth(clean, f.rrn_back1) || f.birth;
      const gender = f.rrn_back1
        ? ["1", "3", "5", "7", "9"].includes(f.rrn_back1)
          ? "남"
          : "여"
        : f.gender;
      return { ...f, rrn_front: clean, birth, gender };
    });
  }

  function updRrnBack1(v: string) {
    const clean = v.replace(/\D/g, "").slice(0, 1);
    setForm((f) => {
      const birth = rrnToBirth(f.rrn_front, clean) || f.birth;
      const gender = clean ? (["1", "3", "5", "7", "9"].includes(clean) ? "남" : "여") : f.gender;
      return { ...f, rrn_back1: clean, birth, gender };
    });
  }

  function addNeed(n: string) {
    const v = n.trim();
    if (!v) return;
    setForm((f) => (f.needs.includes(v) ? f : { ...f, needs: [...f.needs, v] }));
  }
  function removeNeed(n: string) {
    setForm((f) => ({ ...f, needs: f.needs.filter((x) => x !== n) }));
  }

  // 도로명/지번(구주소) 검색 → 표준 주소로 입력 (네이버 지오코딩 정확도 향상)
  async function searchAddress() {
    try {
      await openAddressSearch(({ road, jibun }) => {
        upd("address", road || jibun);
        setDetailOpen(true);
      });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function save() {
    if (!form.name.trim()) return toast.error("이름을 입력해주세요.");
    if (!client && dupNames.length > 0) return toast.error("동일한 이름의 대상자가 이미 등록되어 있습니다.");
    if (!org) return;
    setSaving(true);
    try {
    const payload = {
      name: form.name.trim(),
      registered_at: form.registered_at || null,
      rrn_front: form.rrn_front.trim() || null,
      rrn_back1: form.rrn_back1.trim() || null,
      birth: form.birth || null,
      gender: form.gender || null,
      phone: form.phone || null,
      address: form.address.trim() || null,
      housing: form.housing || null,
      education: form.education || null,
      welfare_status: form.welfare_status || null,
      type: programsToType(programs), // 사업 구분(콤마 저장). 빈 값이면 사례관리
      grade: form.care_level, // 사례관리 구분을 grade 컬럼에 저장
      risk: form.risk,
      needs: form.needs.map((s) => s.trim()).filter(Boolean),
      progress: Number(form.progress) || 0,
      // 비고를 저장하되, 재사정 이력·목표분석·종결사유(note에 함께 보관)는 보존한다
      note: (() => {
        const rest = splitNote(client?.note ?? null);
        const closeReason = form.care_level === "종결" ? (form.closeReason.trim() || null) : null;
        return joinNote(form.note, rest.reassessments, rest.goalAnalysis, closeReason, rest.sideDishAssessments, rest.mealOpinion, rest.familyMembers);
      })(),
      worker_name: form.worker_name.trim() || workerName,
      org_id: org.id,
    };

    // 핵심 저장 (가계도는 제외 — 컬럼 미반영 시에도 대상자 저장이 깨지지 않도록 분리)
    let clientId = client?.id ?? null;
    let clientCode: string | null = client?.client_code ?? null; // Drive 파일명에 이름 대신 쓴다
    if (client) {
      const { data: updated, error } = await supabase
        .from("clients")
        .update(payload)
        .eq("id", client.id)
        .eq("updated_at", client.updated_at)
        .select("id");
      if (error) throw new Error(error.message);
      if (!updated || updated.length === 0) {
        throw new Error("다른 담당자가 방금 수정했습니다. 새로고침 후 다시 시도해주세요.");
      }
    } else {
      const { data, error } = await supabase.from("clients").insert(payload).select("id, client_code").single();
      if (error) throw new Error(error.message);
      clientId = data?.id ?? null;
      clientCode = data?.client_code ?? null;
    }

    // household·address_detail — schema cache 우회를 위해 RPC로 별도 저장 (best-effort)
    if (clientId) {
      await supabase.rpc("patch_client_extra", {
        p_id: clientId,
        p_household: form.household || undefined,
        p_address_detail: addressDetail.trim() || undefined,
      });
    }

    // 가계도 저장 (best-effort) — PNG data URI는 Google Drive에 업로드 후 URL만 DB에 보관
    if (clientId && (form.genogram || "") !== (client?.genogram ?? "")) {
      let genogramValue = form.genogram || null;

      // data URI인 경우 Drive에 업로드 → URL로 교체 (DB 용량 절감)
      if (genogramValue && genogramValue.startsWith("data:image/")) {
        try {
          const base64 = genogramValue.split(",")[1]; // "data:image/png;base64," 제거
          const dateStr = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
          // 파일명 특수문자 제거 (Drive 안전). 이름 대신 대상자 번호를 쓴다(Drive 목록·링크 공유에서 이름 노출 방지, 번호가 없으면 id 앞자리)
          const safeName = (clientCode ?? clientId.slice(0, 8)).replace(/[/\\?%*:|"<>]/g, "").trim();
          const driveRes = await supabase.functions.invoke("drive-proxy", {
            body: {
              name: `${safeName}_가계도_${dateStr}.png`,
              mimeType: "image/png",
              data: base64,
              clientId,
              folderName: "가계도",
            },
          });
          const driveData = driveRes.data as { id?: string; error?: string } | null;
          if (!driveRes.error && driveData?.id) {
            // thumbnail API — uc?export=view는 구글이 차단; thumbnail은 공유된 파일에서 안정적으로 동작
            genogramValue = `https://drive.google.com/thumbnail?id=${driveData.id}&sz=w1600`;
          } else {
            console.warn("가계도 Drive 업로드 실패, data URI 유지:", driveData?.error ?? driveRes.error);
          }
        } catch (e) {
          console.warn("가계도 Drive 업로드 오류, data URI 유지:", e);
        }
      }

      const { error: gErr } = await supabase
        .from("clients")
        .update({ genogram: genogramValue } as never)
        .eq("id", clientId);
      if (gErr) {
        console.warn("genogram save skipped:", gErr.message);
        toast.info("대상자는 저장됐어요. 가계도는 DB 반영(배포) 후 저장됩니다.");
      }
    }

    toast.success(client ? "수정되었습니다." : "등록되었습니다.");
    onOpenChange(false);
    onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const rosterOptions = Array.from(new Set([...workers, form.worker_name].filter(Boolean)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {client ? "대상자 수정" : "대상자 추가"}
            {client?.client_code && (
              <span className="font-mono text-sm font-normal text-muted-foreground" title="대상자 고유번호 (수정할 수 없어요)">
                {client.client_code}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            이름·구분·담당자만 입력해도 바로 등록돼요. 상세 정보는 아래 [상세 정보]를 펼쳐 나중에
            채워도 됩니다.{!client && " 대상자 번호는 저장하면 자동으로 붙어요."}
          </DialogDescription>
        </DialogHeader>

        {/* 빠른 등록: 필수/핵심 항목 */}
        <div className="rounded-lg border border-primary/30 bg-accent/20 p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="이용자명 *">
              <Input
                value={form.name}
                onChange={(e) => upd("name", e.target.value)}
                placeholder="성함"
                autoFocus
              />
              {!client && dupNames.length > 0 && (
                <p className="text-[11px] text-red-500 mt-0.5">
                  이미 등록된 대상자입니다. 확인해주세요.
                </p>
              )}
            </Field>
            <Field label="연락처">
              <Input
                value={form.phone}
                onChange={(e) => upd("phone", e.target.value)}
                placeholder="010-0000-0000"
              />
            </Field>

            {/* 사례관리 구분(중점/일반) — 사례관리 대상자이고 종결 상태가 아닐 때만 */}
            {programs.includes("사례관리") && form.care_level !== "종결" && (
              <Field label="사례관리 구분">
                <div className="flex gap-1.5">
                  {CARE_LEVELS.map((lv) => (
                    <Button
                      key={lv}
                      type="button"
                      size="sm"
                      variant={form.care_level === lv ? "default" : "outline"}
                      className="flex-1"
                      onClick={() => upd("care_level", lv)}
                    >
                      {lv}
                    </Button>
                  ))}
                </div>
              </Field>
            )}

            {/* 종결 처리 — 모든 대상자 */}
            <Field label="종결 처리">
              <Button
                type="button"
                size="sm"
                variant={form.care_level === "종결" ? "destructive" : "outline"}
                onClick={() =>
                  upd(
                    "care_level",
                    form.care_level === "종결"
                      ? programs.includes("사례관리") ? "일반" : "일반"
                      : "종결",
                  )
                }
              >
                {form.care_level === "종결" ? "종결됨 (클릭 시 복귀)" : "종결 처리"}
              </Button>
              {form.care_level === "종결" && (
                <div className="mt-2 space-y-1.5">
                  <p className="text-[11px] text-muted-foreground">종결 사유를 선택하거나 직접 입력하세요.</p>
                  <div className="flex flex-wrap gap-1.5">
                    {CLOSE_REASONS.filter((r) => r !== "직접입력").map((r) => (
                      <Button
                        key={r}
                        type="button"
                        size="sm"
                        variant={form.closeReason === r ? "default" : "outline"}
                        className="text-xs h-7"
                        onClick={() => upd("closeReason", form.closeReason === r ? "" : r)}
                      >
                        {r}
                      </Button>
                    ))}
                  </div>
                  <Input
                    value={(["이사", "사망", "본인의사"] as string[]).includes(form.closeReason) ? "" : form.closeReason}
                    onChange={(e) => upd("closeReason", e.target.value)}
                    placeholder="직접 입력 (이사·사망·본인의사 외 사유)"
                    className="h-8 text-sm"
                  />
                </div>
              )}
            </Field>

            <Field label="담당자">
              {workerDirect ? (
                <div className="flex gap-1">
                  <Input
                    value={form.worker_name}
                    onChange={(e) => upd("worker_name", e.target.value)}
                    placeholder="담당자 이름"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setWorkerDirect(false)}
                  >
                    목록
                  </Button>
                </div>
              ) : (
                <SelectSimple
                  value={form.worker_name || undefined}
                  onChange={(v) => {
                    if (v === DIRECT) {
                      setWorkerDirect(true);
                      upd("worker_name", "");
                    } else upd("worker_name", v);
                  }}
                  options={rosterOptions}
                  extra={{ value: DIRECT, label: "+ 직접 입력" }}
                  placeholder="담당자 선택"
                />
              )}
            </Field>

            <Field label="사업 구분 (여러 개 선택 가능)">
              <div className="flex flex-wrap gap-1.5">
                {PROGRAMS.map((p) => (
                  <Button
                    key={p}
                    type="button"
                    size="sm"
                    variant={programs.includes(p) ? "default" : "outline"}
                    onClick={() => toggleProgram(p)}
                  >
                    {p}
                  </Button>
                ))}
              </div>
            </Field>
            <Field label="위험도">
              <SelectSimple
                value={form.risk}
                onChange={(v) => upd("risk", v)}
                options={[...RISK_LEVELS]}
              />
            </Field>
          </div>

          {/* 욕구 원클릭 추가 */}
          <div>
            <Label className="text-xs">욕구 (클릭해서 추가)</Label>
            {form.needs.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {form.needs.map((n) => (
                  <span
                    key={n}
                    className="inline-flex items-center gap-1 text-xs bg-secondary text-secondary-foreground rounded-full pl-2.5 pr-1 py-0.5"
                  >
                    #{n}
                    <button
                      type="button"
                      onClick={() => removeNeed(n)}
                      className="hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="mt-2 space-y-1.5">
              {Object.entries(NEED_PRESETS).map(([area, items]) => (
                <div key={area} className="flex items-start gap-2">
                  <span className="text-[11px] text-muted-foreground w-14 shrink-0 pt-1">
                    {area}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {items.map((it) => (
                      <button
                        key={it}
                        type="button"
                        onClick={() => addNeed(it)}
                        disabled={form.needs.includes(it)}
                        className="text-[11px] rounded-full border px-2 py-0.5 transition-colors disabled:opacity-40 disabled:cursor-default hover:bg-accent border-border"
                      >
                        {form.needs.includes(it) ? "✓ " : "+ "}
                        {it}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-1 mt-2">
              <Input
                value={needInput}
                onChange={(e) => setNeedInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addNeed(needInput);
                    setNeedInput("");
                  }
                }}
                placeholder="직접 입력 후 Enter"
                className="h-8 text-sm"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  addNeed(needInput);
                  setNeedInput("");
                }}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* 상세 정보 (접기) */}
        <Collapsible open={detailOpen} onOpenChange={setDetailOpen}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="w-full justify-between">
              <span className="text-xs text-muted-foreground">
                상세 정보 (주민번호·주소·주거·학력 등){client ? "" : " — 나중에 채워도 됩니다"}
              </span>
              <ChevronDown
                className={`h-4 w-4 transition-transform ${detailOpen ? "rotate-180" : ""}`}
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3">
              <Field label="주민번호 앞 6자리">
                <Input
                  maxLength={6}
                  placeholder="000000"
                  value={form.rrn_front}
                  onChange={(e) => updRrnFront(e.target.value)}
                />
              </Field>
              <Field label="뒷자리 첫 숫자">
                <Input
                  maxLength={1}
                  placeholder="1~4"
                  value={form.rrn_back1}
                  onChange={(e) => updRrnBack1(e.target.value)}
                />
              </Field>

              <Field label="생년월일">
                <Input
                  type="date"
                  value={form.birth}
                  onChange={(e) => upd("birth", e.target.value)}
                />
              </Field>
              <Field label="성별">
                <SelectSimple
                  value={form.gender}
                  onChange={(v) => upd("gender", v)}
                  options={GENDER_TYPES}
                />
              </Field>

              <Field label="대상구분">
                <SelectSimple
                  value={form.welfare_status}
                  onChange={(v) => upd("welfare_status", v)}
                  options={WELFARE_STATUS}
                />
              </Field>
              <Field label="등록일자">
                <Input
                  type="date"
                  value={form.registered_at}
                  onChange={(e) => upd("registered_at", e.target.value)}
                />
              </Field>

              <Field label="주거형태">
                <SelectSimple
                  value={form.housing || "미입력"}
                  onChange={(v) => upd("housing", v === "미입력" ? "" : v)}
                  options={["미입력", ...HOUSING_TYPES]}
                />
              </Field>
              <Field label="동거형태">
                <SelectSimple
                  value={form.household || "미입력"}
                  onChange={(v) => upd("household", v === "미입력" ? "" : v)}
                  options={["미입력", ...HOUSEHOLD_TYPES]}
                />
              </Field>
              <Field label="학력">
                <SelectSimple
                  value={form.education}
                  onChange={(v) => upd("education", v)}
                  options={EDUCATION_TYPES}
                />
              </Field>
              <div />

              <div className="sm:col-span-2">
                <Field label="주소">
                  <div className="flex gap-1">
                    <Input
                      value={form.address}
                      onChange={(e) => upd("address", e.target.value)}
                      placeholder="도로명·지번 주소"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0"
                      onClick={searchAddress}
                    >
                      <Search className="h-4 w-4" />
                      주소 검색
                    </Button>
                  </div>
                  <Input
                    className="mt-1.5"
                    value={addressDetail}
                    onChange={(e) => setAddressDetail(e.target.value)}
                    placeholder="상세주소 (동·호수 등)"
                  />
                </Field>
              </div>

              <div className="sm:col-span-2">
                <Field label="비고">
                  <Textarea
                    rows={2}
                    value={form.note}
                    onChange={(e) => upd("note", e.target.value)}
                  />
                </Field>
              </div>

              <div className="sm:col-span-2">
                <Label className="text-xs flex items-center gap-1">
                  <Network className="h-3.5 w-3.5" />
                  가계도 (선택)
                </Label>
                <div className="mt-1 flex items-center gap-3">
                  {form.genogram ? (
                    <img
                      src={toGenogramDisplayUrl(form.genogram)}
                      alt="가계도"
                      className="h-24 rounded border border-border bg-white object-contain"
                    />
                  ) : (
                    <div className="h-24 flex-1 rounded border border-dashed border-border flex items-center justify-center text-xs text-muted-foreground">
                      아직 그린 가계도가 없습니다
                    </div>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setGenoOpen(true)}
                  >
                    <Pencil className="h-4 w-4" />
                    {form.genogram ? "수정" : "그리기"}
                  </Button>
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <GenogramEditor
          open={genoOpen}
          onOpenChange={setGenoOpen}
          value={form.genogram || null}
          onSave={(url) => upd("genogram", url ?? "")}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "저장 중..." : "저장"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function SelectSimple({
  value,
  onChange,
  options,
  placeholder,
  extra,
}: {
  value: string | undefined;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  extra?: { value: string; label: string };
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder ?? "선택"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
        {extra && <SelectItem value={extra.value}>{extra.label}</SelectItem>}
      </SelectContent>
    </Select>
  );
}
