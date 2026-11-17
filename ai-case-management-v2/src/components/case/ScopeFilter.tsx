import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROGRAMS } from "@/lib/case-types";

export type CareValue = "전체" | "중점" | "일반";

type Props = {
  program: string;
  onProgram: (p: string) => void;
  care: CareValue;
  onCare: (c: CareValue) => void;
  worker: string;
  onWorker: (w: string) => void;
  workers: string[];
  /** 사업별 인원수(선택) — {전체, 사례관리, 밑반찬, 무료급식, 종결} */
  counts?: Record<string, number>;
};

/**
 * 대상자 구분 필터 바.
 * 1줄: 사업 구분 [전체·사례관리·밑반찬·무료급식·종결]
 * 2줄: (사례관리 선택 시) 중점/일반 + 담당자
 */
export function ScopeFilter({
  program,
  onProgram,
  care,
  onCare,
  worker,
  onWorker,
  workers,
  counts,
}: Props) {
  const activeTabs = ["전체", ...PROGRAMS];
  function pick(p: string) {
    onProgram(p);
    if (p !== "사례관리") onCare("전체");
  }
  return (
    <div className="space-y-2">
      {/* 사업 구분 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {activeTabs.map((t) => (
          <Button
            key={t}
            size="sm"
            variant={program === t ? "default" : "outline"}
            onClick={() => pick(t)}
          >
            {t}
            {counts && counts[t] != null && (
              <span className="ml-1 text-[11px] opacity-70">{counts[t]}</span>
            )}
          </Button>
        ))}
        {/* 종결 탭 — 항상 마지막 */}
        <Button
          size="sm"
          variant={program === "종결" ? "secondary" : "ghost"}
          className={program === "종결" ? "text-muted-foreground" : "text-muted-foreground border border-dashed"}
          onClick={() => pick("종결")}
        >
          종결
          {counts?.종결 != null && counts.종결 > 0 && (
            <span className="ml-1 text-[11px] opacity-70">{counts.종결}</span>
          )}
        </Button>
      </div>

      {/* 중점/일반 (사례관리일 때만) + 담당자 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {program === "사례관리" && (
          <>
            <span className="text-[11px] text-muted-foreground">사례관리 구분</span>
            {(["전체", "중점", "일반"] as const).map((lv) => (
              <Button
                key={lv}
                size="sm"
                variant={care === lv ? "default" : "outline"}
                className="h-8"
                onClick={() => onCare(lv)}
              >
                {lv}
              </Button>
            ))}
            <div className="h-5 w-px bg-border mx-1" />
          </>
        )}
        <span className="text-[11px] text-muted-foreground">담당자</span>
        <Select value={worker} onValueChange={onWorker}>
          <SelectTrigger className="w-32 h-8">
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
    </div>
  );
}
