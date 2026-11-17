/**
 * SideDishAddDialog — PDF로 대상자 신규 등록
 *
 * 흐름:
 *   1) PDF 업로드
 *   2) AI가 대상자 기본정보 추출
 *   3) 내용 확인·수정 후 등록 확정
 *   (실태조사는 등록 후 실태조사 탭에서 PDF 별도 업로드)
 */
import { useState, useEffect } from "react";
import { programDefaultWorker } from "@/lib/worker-defaults";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { analyzeSideDishPdf } from "@/lib/ai.functions";
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
import { toast } from "sonner";
import { Upload, Loader2, FileText } from "lucide-react";
import { extractPdfText, aiErrorMsg } from "@/lib/pdf-utils";
import {
  WELFARE_STATUS,
  GENDER_TYPES,
  CARE_LEVELS,
  HOUSING_TYPES,
  HOUSEHOLD_TYPES,
  type OrgRow,
} from "@/lib/case-types";
import { openAddressSearch, type AddressResult } from "@/lib/daum-postcode";

// 주민번호 앞자리 → 생년월일
function rrnToBirth(front: string, back1: string): string {
  if (front.length !== 6 || !/^\d{6}$/.test(front)) return "";
  const yy = front.slice(0, 2), mm = front.slice(2, 4), dd = front.slice(4, 6);
  let century = "";
  if (["1", "2", "5", "6"].includes(back1)) century = "19";
  else if (["3", "4", "7", "8"].includes(back1)) century = "20";
  else century = Number(yy) > 25 ? "19" : "20";
  const m = Number(mm), d = Number(dd);
  if (m < 1 || m > 12 || d < 1 || d > 31) return "";
  return `${century}${yy}-${mm}-${dd}`;
}

// 생년월일 → 주민번호 앞 6자리
function birthToRrnFront(birth: string): string {
  // "YYYY-MM-DD" → "YYMMDD"
  if (!birth || birth.length < 10) return "";
  return birth.slice(2, 4) + birth.slice(5, 7) + birth.slice(8, 10);
}

// 성별 + 생년월일 → 주민번호 7번째
function genderToBack1(gender: string, birth: string): string {
  const year = birth ? Number(birth.slice(0, 4)) : 0;
  const is2000 = year >= 2000;
  if (["남", "남성"].includes(gender)) return is2000 ? "3" : "1";
  if (["여", "여성"].includes(gender)) return is2000 ? "4" : "2";
  return "";
}

// ── 폼 상태 ───────────────────────────────────────────────────────────
type ClientForm = {
  name: string;
  birth: string;
  gender: string;
  phone: string;
  address: string;
  address_detail: string;
  welfare_status: string;
  worker_name: string;
  rrn_front: string;
  rrn_back1: string;
  note: string;
  household: string; // 동거형태: 독거/부부/가족/조손/기타
  housing: string;   // 주거형태: 자가/전세/월세 등
  grade: string;     // 사례관리 전용: 중점/일반
};

function emptyForm(workerName: string, programType: string): ClientForm {
  return {
    name: "",
    birth: "",
    gender: "여",
    phone: "",
    address: "",
    address_detail: "",
    welfare_status: "일반",
    // 밑반찬 기본 담당자: 환경변수로 지정한 사람(없으면 로그인한 사용자)
    worker_name: programType === "밑반찬" ? (programDefaultWorker("밑반찬") ?? workerName) : workerName,
    rrn_front: "",
    rrn_back1: "",
    note: "",
    household: "",
    housing: "자가",
    grade: "일반",
  };
}

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 등록할 사업 구분: 밑반찬 | 무료급식 | 사례관리 */
  programType: string;
  org: OrgRow | null;
  workerName: string;
  onSaved: () => void;
};

type Step = "upload" | "analyzing" | "review";

export function SideDishAddDialog({ open, onOpenChange, programType, org, workerName, onSaved }: Props) {
  const callAnalyze = useServerFn(analyzeSideDishPdf);

  const [step, setStep] = useState<Step>("upload");
  const [form, setForm] = useState<ClientForm>(emptyForm(workerName, programType));
  const [saving, setSaving] = useState(false);

  // 다이얼로그가 열릴 때마다 programType에 맞게 폼 초기화
  // (닫힐 때 초기화하면 다음 열기 시점에 이전 programType이 남을 수 있음)
  useEffect(() => {
    if (open) {
      setStep("upload");
      setForm(emptyForm(workerName, programType));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]); // open이 true로 바뀌는 순간의 programType·workerName을 사용

  function handleOpenChange(v: boolean) {
    onOpenChange(v);
  }

  function upd<K extends keyof ClientForm>(k: K, v: ClientForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function updRrnFront(v: string) {
    const clean = v.replace(/\D/g, "").slice(0, 6);
    setForm((f) => {
      const birth = rrnToBirth(clean, f.rrn_back1) || f.birth;
      const gender = f.rrn_back1
        ? ["1", "3", "5", "7", "9"].includes(f.rrn_back1) ? "남" : "여"
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

  // 성별 변경 → 주민번호 7번째 자동 갱신
  function updGender(v: string) {
    setForm((f) => {
      const back1 = genderToBack1(v, f.birth) || f.rrn_back1;
      return { ...f, gender: v, rrn_back1: back1 };
    });
  }

  // 생년월일 변경 → 주민번호 앞자리 + 7번째 자동 갱신
  function updBirth(v: string) {
    setForm((f) => {
      const front = birthToRrnFront(v) || f.rrn_front;
      const back1 = genderToBack1(f.gender, v) || f.rrn_back1;
      return { ...f, birth: v, rrn_front: front, rrn_back1: back1 };
    });
  }

  async function handleFileSelect(file: File) {
    setStep("analyzing");
    try {
      const text = await extractPdfText(file);
      if (!text.trim()) {
        toast.error("PDF에서 텍스트를 추출할 수 없습니다. 스캔 이미지 PDF는 지원되지 않습니다.");
        setStep("upload");
        return;
      }
      const result = await callAnalyze({ data: { text } });
      if (!result.ok) {
        toast.error(result.error || "AI 분석에 실패했습니다.");
        setStep("upload");
        return;
      }

      // 대상자 기본정보 채우기
      const ci = result.clientInfo ?? {};
      setForm((f) => {
        const gender = ci.gender || f.gender;
        const birth = ci.birth || f.birth;
        const rrnFront = birthToRrnFront(birth) || f.rrn_front;
        const back1 = genderToBack1(gender, birth) || f.rrn_back1;
        return {
          ...f,
          name: ci.name || f.name,
          birth,
          gender,
          phone: ci.phone || f.phone,
          address: ci.address || f.address,
          address_detail: ci.address_detail || f.address_detail,
          welfare_status: ci.welfare || f.welfare_status,
          household: ci.household || f.household,
          housing: ci.housing || f.housing,
          rrn_front: rrnFront,
          rrn_back1: back1,
        };
      });

      setStep("review");
    } catch (e) {
      toast.error(aiErrorMsg((e as Error).message));
      setStep("upload");
    }
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error("이름을 입력해 주세요."); return; }
    if (!org) { toast.error("기관 정보가 없습니다."); return; }

    setSaving(true);
    try {
      const noteStr = form.note.trim() || null;

      const insertRow = {
        org_id: org.id,
        name: form.name.trim(),
        type: programType,
        risk: "정상",
        grade: programType === "사례관리" ? form.grade : "일반",
        gender: form.gender || null,
        birth: form.birth || null,
        rrn_front: form.rrn_front || null,
        rrn_back1: form.rrn_back1 || null,
        phone: form.phone || null,
        address: form.address.trim() || null,
        housing: form.housing || null,
        welfare_status: form.welfare_status || null,
        worker_name: form.worker_name.trim() || workerName,
        note: noteStr,
        registered_at: new Date().toISOString().slice(0, 10),
      };

      const { data: inserted, error } = await supabase
        .from("clients")
        .insert(insertRow)
        .select("id")
        .single();
      if (error) throw new Error(error.message);

      // household·address_detail은 schema cache 우회를 위해 RPC로 별도 저장
      // Fix #1: RPC 오류를 확인해 조용히 넘어가지 않도록 함
      if (inserted?.id) {
        const { error: rpcErr } = await supabase.rpc("patch_client_extra", {
          p_id: inserted.id,
          p_household: form.household || undefined,
          p_address_detail: form.address_detail.trim() || undefined,
        });
        if (rpcErr) {
          console.warn("patch_client_extra 실패:", rpcErr.message);
          toast.warning("동거형태·상세주소 저장에 실패했습니다. 대상자 편집에서 다시 저장해 주세요.");
        }
      }
      toast.success(`${form.name.trim()} 님이 ${programType} 대상자로 등록됐습니다.`);
      onSaved();
      handleOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{programType} 대상자 등록</DialogTitle>
          <DialogDescription>
            {step === "upload" && "대상자 정보가 담긴 PDF를 업로드하면 AI가 기본 인적사항을 자동으로 채워드립니다."}
            {step === "analyzing" && "AI가 PDF에서 대상자 정보를 읽고 있습니다…"}
            {step === "review" && "추출된 정보를 확인하고 수정한 뒤 등록하세요."}
          </DialogDescription>
        </DialogHeader>

        {/* ── Step: upload ── */}
        {step === "upload" && (
          <div className="flex flex-col items-center justify-center py-10 gap-4">
            <FileText className="h-12 w-12 text-muted-foreground opacity-60" />
            <p className="text-sm text-center text-muted-foreground max-w-xs">
              대상자 정보가 포함된 PDF를 업로드하세요.<br />
              이름·생년월일·주소 등 기본 인적사항을 자동으로 입력합니다.
            </p>
            <label className="cursor-pointer">
              <Button asChild>
                <span>
                  <Upload className="h-4 w-4 mr-1.5" />
                  PDF 업로드
                </span>
              </Button>
              <input
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFileSelect(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        )}

        {/* ── Step: analyzing ── */}
        {step === "analyzing" && (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              잠시만 기다려주세요. 대상자 정보를 읽고 있어요.
            </p>
          </div>
        )}

        {/* ── Step: review ── */}
        {step === "review" && (
          <div className="space-y-4 py-1">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">대상자 기본정보</h3>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">이름 *</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => upd("name", e.target.value)}
                    placeholder="홍길동"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">성별</Label>
                  <Select value={form.gender} onValueChange={updGender}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GENDER_TYPES.map((g) => (
                        <SelectItem key={g} value={g}>{g}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">주민번호 앞 6자리</Label>
                  <Input
                    value={form.rrn_front}
                    onChange={(e) => updRrnFront(e.target.value)}
                    placeholder="YYMMDD"
                    maxLength={6}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">주민번호 7번째</Label>
                  <Input
                    value={form.rrn_back1}
                    onChange={(e) => updRrnBack1(e.target.value)}
                    placeholder="남1·여2"
                    maxLength={1}
                    className="mt-1"
                  />
                </div>
              </div>

              <div>
                <Label className="text-xs">생년월일</Label>
                <Input
                  type="date"
                  value={form.birth}
                  onChange={(e) => updBirth(e.target.value)}
                  className="mt-1"
                />
              </div>

              <div>
                <Label className="text-xs">연락처</Label>
                <Input
                  value={form.phone}
                  onChange={(e) => upd("phone", e.target.value)}
                  placeholder="010-0000-0000"
                  className="mt-1"
                />
              </div>

              <div>
                <Label className="text-xs">주소</Label>
                <div className="flex gap-2 mt-1">
                  <Input
                    value={form.address}
                    onChange={(e) => upd("address", e.target.value)}
                    placeholder="주소 입력 또는 검색"
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      openAddressSearch((r: AddressResult) => upd("address", r.road || r.jibun))
                    }
                  >
                    검색
                  </Button>
                </div>
                <Input
                  value={form.address_detail}
                  onChange={(e) => upd("address_detail", e.target.value)}
                  placeholder="상세주소 (동·호수 등)"
                  className="mt-1.5"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">수급 여부</Label>
                  <Select value={form.welfare_status} onValueChange={(v) => upd("welfare_status", v)}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WELFARE_STATUS.map((w) => (
                        <SelectItem key={w} value={w}>{w}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">주거형태</Label>
                  <Select value={form.housing} onValueChange={(v) => upd("housing", v)}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HOUSING_TYPES.map((h) => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label className="text-xs">동거형태</Label>
                <Select
                  value={form.household || "미입력"}
                  onValueChange={(v) => upd("household", v === "미입력" ? "" : v)}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["미입력", ...HOUSEHOLD_TYPES].map((h) => (
                      <SelectItem key={h} value={h}>{h}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {programType === "사례관리" && (
                <div>
                  <Label className="text-xs">사례관리 구분</Label>
                  <Select value={form.grade} onValueChange={(v) => upd("grade", v)}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CARE_LEVELS.map((lv) => (
                        <SelectItem key={lv} value={lv}>{lv}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div>
                <Label className="text-xs">담당자</Label>
                <Input
                  value={form.worker_name}
                  onChange={(e) => upd("worker_name", e.target.value)}
                  placeholder="담당 사회복지사 이름"
                  className="mt-1"
                />
              </div>

              <div>
                <Label className="text-xs">비고</Label>
                <Textarea
                  rows={2}
                  value={form.note}
                  onChange={(e) => upd("note", e.target.value)}
                  className="mt-1 text-sm"
                />
              </div>
            </div>

            <p className="text-xs text-muted-foreground px-0.5">
              실태조사는 등록 후 해당 대상자의 [실태조사] 탭에서 PDF를 업로드하면 됩니다.
            </p>
          </div>
        )}

        {step === "review" && (
          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
              취소
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              등록 확정
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
