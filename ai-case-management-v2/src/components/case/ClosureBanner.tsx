import { AlertTriangle, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isTerminated, terminatedStyle, type Client } from "@/lib/case-types";
import {
  closeReasonFromNote,
  closureReasonText,
  closureResultLabel,
  closureTypeLabel,
  useClosureSummary,
} from "@/lib/closure-summary";

/**
 * 종결 대상자 상세 위쪽에 종결 사실(종결일·사유·결과)을 한 줄로 보여 주는 띠.
 * 사유는 종결보고의 유형을 우선하고, 없으면 수정 창에서 고른 사유를 쓴다. 둘 다 없으면 '미입력' 경고.
 */
export function ClosureBanner({
  client,
  tick,
  onOpenReport,
}: {
  client: Client;
  /** 종결보고를 저장하면 올려서 요약을 다시 불러오게 한다 */
  tick: number;
  onOpenReport: () => void;
}) {
  const terminated = isTerminated(client);
  const { summary, loaded } = useClosureSummary(client.id, terminated, tick);
  if (!terminated) return null;

  const noteReason = closeReasonFromNote(client.note);
  const typeLabel = closureTypeLabel(summary);
  const reason = closureReasonText(summary, client.note);
  const result = closureResultLabel(summary);
  const date = summary?.closure_date?.trim() || null;
  // 종결보고의 유형과 수정 창의 사유가 서로 다르면 둘 다 보여 준다(어느 쪽도 숨기지 않기)
  const noteExtra = typeLabel && noteReason && noteReason !== typeLabel ? noteReason : null;
  const missing = loaded && !reason;

  return (
    <div
      className={`mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border px-3 py-2 text-sm ${
        missing ? "border-amber-300 bg-amber-50/60" : "border-zinc-300 bg-zinc-50"
      }`}
    >
      <Badge variant="outline" className={terminatedStyle}>
        종결
      </Badge>
      {!loaded ? (
        <span className="text-xs text-muted-foreground">종결 정보를 불러오는 중…</span>
      ) : (
        <>
          {date && (
            <span className="text-xs">
              <span className="text-muted-foreground">종결일 </span>
              {date}
            </span>
          )}
          {reason ? (
            <span className="text-xs">
              <span className="text-muted-foreground">사유 </span>
              {reason}
              {noteExtra && <span className="text-muted-foreground"> · 수정 창 사유: {noteExtra}</span>}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5" />
              종결 사유 미입력
            </span>
          )}
          {result && (
            <span className="text-xs">
              <span className="text-muted-foreground">결과 </span>
              {result}
            </span>
          )}
        </>
      )}
      <Button size="sm" variant="outline" className="ml-auto h-7 px-2 text-xs" onClick={onOpenReport}>
        <FileText className="h-3.5 w-3.5" />
        {missing ? "종결보고에서 입력" : "종결보고 보기"}
      </Button>
    </div>
  );
}
