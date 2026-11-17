/**
 * CounselTab 공유 헬퍼 함수 및 상수
 * ChatPanel, CounselListView, CounselPatternCard, ProvisionPanel,
 * BulkSideDishDialog, BulkCaseDialog 등에서 공통 사용
 */
import { Fragment } from "react";
import type { ReactNode } from "react";
import { Phone, Home, MessageSquare, Video, Users } from "lucide-react";
import * as XLSX from "xlsx";
import { ORG_NAME } from "@/lib/org-config";

// ── 상수 ────────────────────────────────────────────────────────
export const AGENCY_PRESETS = [ORG_NAME, "관할 구청"] as const;

export const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

export const METHOD_COLORS: Record<string, string> = {
  전화: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  방문: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  문자: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  화상: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  내방: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
};

// ── 타입 ────────────────────────────────────────────────────────
export type LogInsert = {
  client_id: string;
  org_id: string;
  method: string;
  note: string;
  worker_name: string | null;
  created_at?: string;
};

// ── 헬퍼 컴포넌트 ────────────────────────────────────────────────
export function MethodIcon({ m }: { m: string | null }) {
  const map: Record<string, ReactNode> = {
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
        <MessageSquare className="h-3.5 w-3.5" />
      )}
    </>
  );
}

// 키워드 하이라이트
export function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function Highlighted({ text, kw }: { text: string; kw: string }) {
  const k = kw.trim();
  if (!k) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRe(k)})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === k.toLowerCase() ? (
          <mark key={i} className="rounded bg-yellow-200 px-0.5 text-foreground">
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

// ── 엑셀 파싱 헬퍼 ──────────────────────────────────────────────
export function cstr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && s !== "-" ? s : null;
}

export function normMethod(v: string | null): string {
  const s = v ?? "";
  if (s.includes("전화")) return "전화";
  if (s.includes("방문")) return "방문";
  if (s.includes("문자")) return "문자";
  if (s.includes("내방")) return "내방";
  return s || "전화";
}

// 상담일자(문자열/엑셀 날짜/숫자) → 그 날짜 정오의 ISO. 연도 구분이 정확하도록.
export function parseCounselDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  let y = 0, mo = 0, d = 0;
  if (typeof v === "number") {
    const dc = XLSX.SSF?.parse_date_code?.(v);
    if (dc && dc.y) {
      y = dc.y;
      mo = dc.m;
      d = dc.d;
    }
  } else if (v instanceof Date && !isNaN(v.getTime())) {
    y = v.getFullYear();
    mo = v.getMonth() + 1;
    d = v.getDate();
  } else {
    const m = String(v)
      .trim()
      .match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (m) {
      y = +m[1];
      mo = +m[2];
      d = +m[3];
    }
  }
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // 연도가 비현실적이면(2010년 이전 또는 미래 5년 초과) null → DB default(now()) 사용
  const curY = new Date().getFullYear();
  if (y < 2010 || y > curY + 5) return null;
  return new Date(y, mo - 1, d, 12, 0, 0).toISOString();
}
