import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { splitNote } from "@/lib/case-types";

/**
 * 종결 대상자의 종결 요약(종결일·유형·결과).
 * 정본은 종결보고(closure_reports)이고, 종결보고가 없으면 수정 창에서 고른 종결 사유(clients.note 안)를 쓴다.
 */
export type ClosureSummary = {
  client_id: string;
  closure_date: string | null;
  closure_type: string | null;
  closure_type_detail: string | null;
  closure_result: string | null;
  referral_org: string | null;
};

const COLS = "client_id,closure_date,closure_type,closure_type_detail,closure_result,referral_org";

/** 한 대상자의 종결보고 요약(가장 최근 1건). 없으면 null */
export async function fetchClosureSummary(clientId: string): Promise<ClosureSummary | null> {
  const { data, error } = await supabase
    .from("closure_reports")
    .select(COLS)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[closure] 종결 요약 조회 실패:", error.message);
    return null;
  }
  return (data as ClosureSummary | null) ?? null;
}

/** 기관 전체의 종결보고 요약(대상자별 가장 최근 1건). 종결 모아보기 목록용 */
export async function fetchClosureSummariesByOrg(orgId: string): Promise<Map<string, ClosureSummary>> {
  const map = new Map<string, ClosureSummary>();
  const { data, error } = await supabase
    .from("closure_reports")
    .select(COLS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) {
    console.warn("[closure] 종결 요약 목록 조회 실패:", error.message);
    return map;
  }
  for (const row of (data ?? []) as ClosureSummary[]) {
    if (!map.has(row.client_id)) map.set(row.client_id, row); // 최신순이라 처음 나온 것이 가장 최근
  }
  return map;
}

/** 종결 유형 문구. 예: "이사", "기타(입원 중 요양원 입소)" */
export function closureTypeLabel(s: ClosureSummary | null | undefined): string | null {
  const type = s?.closure_type?.trim();
  if (!type) return null;
  const detail = s?.closure_type_detail?.trim();
  return detail ? `${type}(${detail})` : type;
}

/** 타기관 의뢰일 때만 결과 문구를 돌려준다(그냥 종결이면 null — 이미 '종결'이라고 표시되므로) */
export function closureResultLabel(s: ClosureSummary | null | undefined): string | null {
  if (s?.closure_result !== "타기관의뢰") return null;
  const org = s.referral_org?.trim();
  return org ? `타기관 의뢰(${org})` : "타기관 의뢰";
}

/** 수정 창에서 고른 종결 사유(clients.note 안에 보관) */
export function closeReasonFromNote(note: string | null): string | null {
  return splitNote(note).closeReason?.trim() || null;
}

/** 종결 사유 문구 하나로 합치기: 종결보고 유형 우선, 없으면 수정 창의 사유 */
export function closureReasonText(s: ClosureSummary | null | undefined, note: string | null): string | null {
  return closureTypeLabel(s) ?? closeReasonFromNote(note);
}

/** 목록 한 줄용 짧은 문구. 예: "2026-10-13 · 이사" (없는 항목은 생략, 둘 다 없으면 "사유 미입력") */
export function closureShortLine(s: ClosureSummary | null | undefined, note: string | null): string {
  const date = s?.closure_date?.trim() || null;
  const reason = closureReasonText(s, note);
  return [date, reason ?? "사유 미입력"].filter(Boolean).join(" · ");
}

/** 종결 요약 불러오기. tick 이 바뀌면(종결보고를 저장한 뒤) 다시 불러온다. */
export function useClosureSummary(clientId: string, enabled: boolean, tick = 0) {
  const [summary, setSummary] = useState<ClosureSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setSummary(null);
      setLoaded(false);
      return;
    }
    let cancelled = false;
    setSummary(null);
    setLoaded(false);
    fetchClosureSummary(clientId)
      .then((s) => {
        if (!cancelled) {
          setSummary(s);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, enabled, tick]);
  return { summary, loaded };
}
