import { Badge } from "@/components/ui/badge";
import { useAiModelStatus } from "@/lib/ai-model";

/**
 * AI 기능이 쓰는 모델 표시. 이름은 서버가 알려 주는 값만 보여 준다(코드에 적어 두지 않음).
 * - model 을 넘기면: 이 결과를 실제로 만든 모델. 기본 설정과 다르면(대체 모델) 주황색으로 알린다.
 * - model 을 넘기지 않으면: 현재 서버에 설정된 모델(task 를 넘기면 그 작업에 설정된 모델).
 */
export function AiModelBadge({ model, task, className = "" }: { model?: string | null; task?: string; className?: string }) {
  const status = useAiModelStatus(task);
  const used = model?.trim() || null;

  if (!used && status && !status.enabled) {
    return (
      <Badge variant="outline" className={`text-[10px] border-amber-500 text-amber-600 ${className}`}>
        AI 미연결
      </Badge>
    );
  }
  const shown = used ?? (status?.enabled ? status.model : "");
  if (!shown) return null;

  const fallback = !!used && !!status?.model && used !== status.model;
  const title = used
    ? fallback
      ? `이 결과는 대체 모델(${used})로 만들었어요. 기본 설정 모델은 ${status?.model}예요.`
      : `이 결과를 만든 AI 모델: ${used}`
    : `현재 설정된 AI 모델: ${shown} (기본 모델이 실패하면 대체 모델로 처리돼 달라질 수 있어요)`;
  return (
    <Badge
      variant="outline"
      title={title}
      className={`text-[10px] font-normal ${
        fallback ? "border-amber-500 text-amber-600" : "border-emerald-500 text-emerald-600"
      } ${className}`}
    >
      AI · {shown}
    </Badge>
  );
}
