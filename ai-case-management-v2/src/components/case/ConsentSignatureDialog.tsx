/**
 * ConsentSignatureDialog — AI 기능 이용 동의서 자필 서명 다이얼로그
 *
 * 법적 증명력 강화 요소:
 *  1. SHA-256 해시 (동의서 전문·버전 + 동의 문구 + 서명 이미지 + 서명자 + 일시)
 *  2. 감사 로그 (서명 일시 KST·담당자·브라우저·획수) → consent_audit_logs 테이블
 *  3. 여러 쪽 PDF (동의서 + 감사 보고서) → Google Drive "AI 기능 동의서" 폴더
 *  4. clients.consent_drive_url 자동 갱신 (기존 업로드 버튼과 동일 컬럼)
 *
 * 동의서 문구는 개인정보 처리방침(src/routes/privacy.tsx)과 일치해야 한다. 문구를 바꾸면 CONSENT_VERSION도 올린다.
 */

import { useRef, useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, PenLine } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { uploadToDrive } from "@/lib/drive";
import { getClientIp } from "@/lib/client-ip.functions";
import { jsPDF } from "jspdf";

// ── 동의서 텍스트 ─────────────────────────────────────────────────────────────
const CONSENT_TITLE = "AI 기능 이용에 대한 동의서";
const CONSENT_VERSION = "2026.10 개정 (v2)";

function buildConsentBody(orgName: string): string {
  return `${orgName}은(는) 사례관리 서비스의 질을 높이기 위해 인공지능(AI) 분석 도구를 사용합니다.
아래 내용을 천천히 읽고 동의 여부를 결정해 주세요.
동의하지 않으셔도 복지 서비스를 받는 데 아무런 불이익이 없습니다.

1. 어떤 AI를 사용하나요
   · 구글(Google LLC)의 Gemini입니다. 결제(유료) 등급으로 사용하며, 이 등급에서는 입력된 내용이 AI 학습에 쓰이지 않습니다.
   · 구글 서버는 미국 등 외국에 있어, 3번의 정보가 해외 서버로 전송됩니다.

2. AI를 어디에 사용하나요
   · 상담 기록 정리와 다듬기
   · 서비스 목표·계획 수립과 달성도 분석
   · 필요한 지원(욕구) 분석과 지원 자원 추천
   · 상담 녹음을 글로 옮기기 (녹음된 음성이 전송됩니다)
   · 문서(PDF) 내용 읽기와 정리
   · 전체 현황 리포트 만들기

3. 어떤 정보가 AI에 전달되나요
   · 이름, 상담 내용, 필요한 지원(욕구), 위험도, 복지 수급 상태, 서비스 이용 내역, 상담 녹음
   · 건강 상태, 경제 상황처럼 민감한 정보가 상담 내용에 들어 있을 수 있습니다.

4. 정보는 어떻게 보관되나요
   · 서비스의 정보는 국내(서울) 서버와 구글 드라이브(구글 서버)에 저장됩니다.
   · 구글은 AI 분석에 사용한 내용을 AI 개선에 쓰지 않으며, 부정 사용을 확인하기 위한 기록만 일정 기간 보관합니다.
   · 보관 기간은 ${orgName}에서 이 정보를 삭제할 때까지입니다. 삭제한 뒤에도 변경 이력과 정기 백업(최대 약 2년)에 남아 있을 수 있습니다.
   · 자세한 내용은 개인정보 처리방침에서 확인할 수 있습니다.

5. 해외 서버 전송 안내 (개인정보 보호법 제28조의8)
   · 받는 곳: Google LLC (미국 등 구글 서버가 있는 나라)
   · 보내는 때와 방법: AI 기능을 사용할 때마다 암호화(TLS)하여 인터넷으로 전송합니다.
   · 사용 목적: AI 분석 결과(요약·분석·추천·글 옮기기)를 만들기 위해서입니다.
   · AI 분석을 위한 전송은 거부할 수 있고, 거부하면 이 분의 정보는 AI 분석에 보내지 않습니다. 다만 구글 드라이브 저장과 정기 백업은 서비스 제공에 필요해 별도로 거부할 수 없습니다. (개인정보 처리방침 참고)

6. 동의하지 않을 권리와 철회
   · 동의하지 않으셔도 복지 서비스 이용에 불이익이 없습니다. 이 경우 담당자가 'AI 기능 활용'을 '거부'로 설정하며, 거부한 분의 정보는 AI에 사용되지 않습니다.
   · 동의한 뒤에도 언제든지 담당자에게 요청해 철회할 수 있습니다. (대상자 관리에서 '거부'로 변경) 철회한 뒤의 정보는 AI에 사용되지 않습니다.
   · 이미 구글로 전송된 정보는 되돌릴 수 없고, 이미 만들어진 AI 리포트에는 내용이 남아 있을 수 있습니다.
   · 철회해도 AI를 제외한 사례관리 서비스는 그대로 이용할 수 있습니다.`;
}

const CONSENT_CHECK_1 =
  "위 내용을 충분히 읽고 이해하였으며, 자유로운 의사로 AI 분석 사용과 해외(구글) 서버 전송에 동의합니다.";
const CONSENT_CHECK_2 =
  "건강·경제 상태 등 민감정보가 AI 분석에 사용되는 것에 별도로 동의합니다.";

// ── 유틸 ──────────────────────────────────────────────────────────────────────
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function nowKst(): string {
  return (
    new Date(Date.now() + 9 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19) + " KST"
  );
}
function dateKst(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ── PDF 캔버스 렌더링 (한글 폰트 내장 불필요 — 브라우저 캔버스 네이티브 지원) ──
const FONT = "'Malgun Gothic', 'Apple SD Gothic Neo', 'NanumGothic', sans-serif";
const A4W = 794;
const A4H = 1123;
const PAD = 56;
const FOOTER_H = 44; // 쪽 번호 영역
const LINE_H = 21;

type WrappedLine = { text: string; indent: number };

/** 한 줄을 maxWidth에 맞게 나눈다. 들여쓰기·글머리표(·)는 이어지는 줄에도 유지한다. */
function wrapLine(ctx: CanvasRenderingContext2D, line: string, maxWidth: number): WrappedLine[] {
  const lead = line.match(/^\s*/)?.[0] ?? "";
  const body = line.slice(lead.length);
  const bullet = body.startsWith("· ") || /^\d+\.\s/.test(body) ? (body.startsWith("· ") ? "· " : "") : "";
  const baseIndent = ctx.measureText(lead).width;
  const hang = bullet ? ctx.measureText(bullet).width : 0;
  const out: WrappedLine[] = [];
  let cur = "";
  let first = true;
  for (const ch of body) {
    const indent = first ? baseIndent : baseIndent + hang;
    const test = cur + ch;
    if (ctx.measureText(test).width + indent > maxWidth && cur) {
      out.push({ text: cur, indent });
      cur = ch;
      first = false;
    } else cur = test;
  }
  out.push({ text: cur, indent: first ? baseIndent : baseIndent + hang });
  return out;
}

type Page = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
function newPage(): Page {
  const canvas = document.createElement("canvas");
  canvas.width = A4W;
  canvas.height = A4H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, A4W, A4H);
  return { canvas, ctx };
}

interface ConsentRenderInput {
  orgName: string;
  clientName: string;
  signerLabel: string; // "대상자 본인" 또는 "대리인 …"
  dateStr: string;
  signatureDataUrl: string;
}

/** 동의서 본문 + 동의 문구 + 서명 → 여러 쪽 PNG data URL 배열 (본문이 길면 자동으로 쪽을 나눈다) */
async function renderConsentPages(input: ConsentRenderInput): Promise<string[]> {
  const { orgName, clientName, signerLabel, dateStr, signatureDataUrl } = input;
  const pages: Page[] = [];
  let page = newPage();
  pages.push(page);
  let y = PAD;
  const bodyMaxW = A4W - PAD * 2;
  const limit = () => A4H - PAD - FOOTER_H;

  const firstHeader = () => {
    const { ctx } = page;
    ctx.font = `15px ${FONT}`;
    ctx.fillStyle = "#555555";
    ctx.textAlign = "center";
    ctx.fillText(orgName, A4W / 2, y);
    y += 32;
    ctx.font = `bold 24px ${FONT}`;
    ctx.fillStyle = "#111111";
    ctx.fillText(CONSENT_TITLE, A4W / 2, y);
    y += 18;
    ctx.strokeStyle = "#222222";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(A4W - PAD, y);
    ctx.stroke();
    y += 26;
    ctx.textAlign = "left";
  };
  const contHeader = () => {
    const { ctx } = page;
    ctx.font = `12px ${FONT}`;
    ctx.fillStyle = "#777777";
    ctx.textAlign = "left";
    ctx.fillText(`${orgName} · ${CONSENT_TITLE} (계속)`, PAD, y);
    y += 12;
    ctx.strokeStyle = "#cccccc";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(A4W - PAD, y);
    ctx.stroke();
    y += 22;
  };
  const ensure = (h: number) => {
    if (y + h > limit()) {
      page = newPage();
      pages.push(page);
      y = PAD;
      contHeader();
    }
  };
  firstHeader();

  // 본문
  page.ctx.textAlign = "left";
  for (const line of buildConsentBody(orgName).split("\n")) {
    if (line.trim() === "") {
      y += 7;
      continue;
    }
    page.ctx.font = `14.5px ${FONT}`;
    for (const w of wrapLine(page.ctx, line, bodyMaxW)) {
      ensure(LINE_H);
      page.ctx.font = `14.5px ${FONT}`;
      page.ctx.fillStyle = "#222222";
      page.ctx.textAlign = "left";
      page.ctx.fillText(w.text, PAD + w.indent, y);
      y += LINE_H;
    }
  }

  // 동의 문구 + 서명자
  ensure(430);
  y += 6;
  {
    const { ctx } = page;
    ctx.strokeStyle = "#aaaaaa";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(A4W - PAD, y);
    ctx.stroke();
    y += 24;
    ctx.font = `bold 14px ${FONT}`;
    ctx.fillStyle = "#111111";
    for (const [i, t] of [CONSENT_CHECK_1, CONSENT_CHECK_2].entries()) {
      for (const w of wrapLine(ctx, `동의 ${i + 1}) ${t}`, bodyMaxW)) {
        ctx.fillText(w.text, PAD + w.indent, y);
        y += LINE_H;
      }
      y += 4;
    }
    y += 10;
    ctx.font = `14px ${FONT}`;
    ctx.fillStyle = "#333333";
    ctx.textAlign = "left";
    ctx.fillText(`대상자 성명: ${clientName}`, PAD, y);
    ctx.textAlign = "right";
    ctx.fillText(`서명 일자: ${dateStr}`, A4W - PAD, y);
    ctx.textAlign = "left";
    y += 24;
    for (const w of wrapLine(ctx, `서명자: ${signerLabel}`, bodyMaxW)) {
      ctx.fillText(w.text, PAD + w.indent, y);
      y += LINE_H;
    }
    y += 8;
    ctx.fillStyle = "#666666";
    ctx.font = `12px ${FONT}`;
    ctx.fillText("[ 자필 서명 ]", PAD, y);
    y += 6;
  }

  // 서명 박스 + 이미지
  const sigH = 180;
  const last = page;
  last.ctx.strokeStyle = "#bbbbbb";
  last.ctx.lineWidth = 1;
  last.ctx.strokeRect(PAD, y, A4W - PAD * 2, sigH);
  const sigTop = y;
  await new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const boxW = A4W - PAD * 2 - 8, boxH = sigH - 8;
      const k = Math.min(boxW / img.width, boxH / img.height, 1.5);
      const w = img.width * k, h = img.height * k;
      last.ctx.drawImage(img, PAD + 4 + (boxW - w) / 2, sigTop + 4 + (boxH - h) / 2, w, h);
      resolve();
    };
    img.onerror = () => resolve(); // 이미지 로드 실패해도 빈 서명란으로 계속
    img.src = signatureDataUrl;
  });

  // 쪽 번호 + 버전
  pages.forEach((p, i) => {
    p.ctx.font = `11px ${FONT}`;
    p.ctx.fillStyle = "#888888";
    p.ctx.textAlign = "center";
    p.ctx.fillText(`${CONSENT_VERSION}  ·  ${i + 1} / ${pages.length}`, A4W / 2, A4H - 28);
  });
  return pages.map((p) => p.canvas.toDataURL("image/png"));
}

interface AuditRenderInput {
  orgName: string;
  clientName: string;
  signerLabel: string;
  workerName: string;
  signedAt: string;
  documentHash: string;
  userAgent: string;
  strokes: number;
  ipAddress: string;
}

/** 감사 보고서 → 마지막 쪽 PNG data URL */
function renderAuditPage(a: AuditRenderInput): string {
  const { canvas, ctx } = newPage();
  ctx.fillStyle = "#f7f8fa";
  ctx.fillRect(0, 0, A4W, A4H);

  let y = PAD;
  const maxW = A4W - PAD * 2;

  ctx.font = `bold 19px ${FONT}`;
  ctx.fillStyle = "#222222";
  ctx.textAlign = "center";
  ctx.fillText("서명 감사 보고서 (Audit Trail)", A4W / 2, y);
  y += 14;

  ctx.strokeStyle = "#444444";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(A4W - PAD, y);
  ctx.stroke();
  y += 30;

  const rows: [string, string][] = [
    ["기관", a.orgName],
    ["동의서 버전", CONSENT_VERSION],
    ["서명 일시 (KST)", a.signedAt],
    ["대상자", a.clientName],
    ["서명자", a.signerLabel],
    ["입회 담당자", a.workerName || "-"],
    ["접속 IP 주소", a.ipAddress],
    ["서명 획수", `${a.strokes}획`],
    ["브라우저 환경", a.userAgent],
    ["문서 해시 (SHA-256)", a.documentHash],
  ];

  const labelW = 180;
  const valueX = PAD + labelW;
  const valueMaxW = maxW - labelW;

  for (const [label, value] of rows) {
    const startY = y;
    ctx.textAlign = "left";
    ctx.font = `13px ${FONT}`;
    ctx.fillStyle = "#555555";
    ctx.fillText(label, PAD, y + 14);

    ctx.font = `bold 12.5px ${FONT}`;
    ctx.fillStyle = "#111111";
    let vy = y + 14;
    for (const w of wrapLine(ctx, value, valueMaxW)) {
      ctx.fillText(w.text, valueX + w.indent, vy);
      vy += 18;
    }
    const rowH = Math.max(vy - startY, 30) + 10;
    y = startY + rowH;

    ctx.strokeStyle = "#e0e0e0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, y - 6);
    ctx.lineTo(A4W - PAD, y - 6);
    ctx.stroke();
  }

  y += 24;
  ctx.font = `11.5px ${FONT}`;
  ctx.fillStyle = "#888888";
  ctx.textAlign = "center";
  ctx.fillText(
    `본 감사 보고서는 ${a.orgName} AI 사례관리 시스템에 의해 자동 생성되었습니다.`,
    A4W / 2,
    y,
  );
  y += 18;
  ctx.fillText(
    "문서 해시값(SHA-256)으로 원본 서명의 위변조 여부를 언제든지 검증할 수 있습니다.",
    A4W / 2,
    y,
  );

  return canvas.toDataURL("image/png");
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  clientName: string;
  clientCode?: string | null; // Drive 파일명에 이름 대신 쓴다
  orgName: string;
  onComplete: (driveUrl: string) => void;
}

type Step = "read" | "sign" | "uploading";

export function ConsentSignatureDialog({
  open,
  onOpenChange,
  clientId,
  clientName,
  clientCode,
  orgName,
  onComplete,
}: Props) {
  const [step, setStep] = useState<Step>("read");
  const [agreed1, setAgreed1] = useState(false);
  const [agreed2, setAgreed2] = useState(false);
  const [proxy, setProxy] = useState(false);
  const [proxyName, setProxyName] = useState("");
  const [proxyRel, setProxyRel] = useState("");
  const [isEmpty, setIsEmpty] = useState(true);
  const [workerName, setWorkerName] = useState("");
  const [orgId, setOrgId] = useState<string | null>(null);
  const [ipAddress, setIpAddress] = useState<string>("-");
  const runGetIp = useServerFn(getClientIp);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);
  const strokesRef = useRef(0);

  const body = buildConsentBody(orgName);
  const signerLabel = proxy
    ? `대리인 ${proxyName.trim()} (대상자와의 관계: ${proxyRel.trim()})`
    : "대상자 본인";
  const canProceed =
    !!orgName.trim() && agreed1 && agreed2 && (!proxy || (!!proxyName.trim() && !!proxyRel.trim()));

  // 담당자·org_id·접속 IP 로드
  useEffect(() => {
    if (!open) return;
    // 담당자 / org_id
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) return;
      supabase
        .from("profiles")
        .select("name, org_id")
        .eq("id", data.user.id)
        .single()
        .then(({ data: p }) => {
          if (p?.name) setWorkerName(p.name);
          if (p?.org_id) setOrgId(p.org_id);
        });
    });
    // 접속 IP — 서버가 요청 헤더에서 읽는다(외부 조회 서비스 사용 안 함). 실패 시 "-" 유지
    runGetIp()
      .then((r) => { if (r.ip) setIpAddress(r.ip); })
      .catch(() => {/* 실패 시 "-" 유지 */});
  }, [open, runGetIp]);

  // 다이얼로그 열릴 때 초기화
  useEffect(() => {
    if (open) {
      setStep("read");
      setAgreed1(false);
      setAgreed2(false);
      setProxy(false);
      setProxyName("");
      setProxyRel("");
      setIsEmpty(true);
    }
  }, [open]);

  // 서명 패드 초기화 (step 전환 시)
  useEffect(() => {
    if (step !== "sign") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 화면에 보이는 크기에 맞춰 그림판 크기를 정한다(폰에서도 서명할 공간이 충분하고, 고해상도 화면에서 선명하게)
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 2.5 * dpr;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    strokesRef.current = 0;
  }, [step]);

  // ── 서명 패드 이벤트 ───────────────────────────────────────────────────────
  function getPos(
    e: React.MouseEvent | React.TouchEvent,
    canvas: HTMLCanvasElement,
  ): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if ("touches" in e) {
      const t = e.touches[0];
      return {
        x: (t.clientX - rect.left) * scaleX,
        y: (t.clientY - rect.top) * scaleY,
      };
    }
    const me = e as React.MouseEvent;
    return {
      x: (me.clientX - rect.left) * scaleX,
      y: (me.clientY - rect.top) * scaleY,
    };
  }

  function startDraw(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    isDrawingRef.current = true;
    strokesRef.current += 1;
    lastPosRef.current = getPos(e, canvas);
    setIsEmpty(false);
  }

  function draw(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    if (!isDrawingRef.current || !canvasRef.current || !lastPosRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d")!;
    const pos = getPos(e, canvas);
    ctx.beginPath();
    ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPosRef.current = pos;
  }

  function endDraw(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    isDrawingRef.current = false;
    lastPosRef.current = null;
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    strokesRef.current = 0;
    setIsEmpty(true);
  }

  // ── PDF 생성 + Drive 업로드 ─────────────────────────────────────────────────
  async function handleUpload() {
    const canvas = canvasRef.current;
    if (!canvas || isEmpty || !canProceed) return;
    setStep("uploading");
    const tid = toast.loading("동의서 생성 중...");

    try {
      const signatureDataUrl = canvas.toDataURL("image/png");
      const signedAt = nowKst();
      const dateStr = dateKst();
      const userAgent = navigator.userAgent;
      const strokes = strokesRef.current;

      // SHA-256: 동의서 전문·버전 + 동의 문구 + 서명자 구분 + 서명 이미지 + 대상자 + 일시
      const documentHash = await sha256(
        [
          CONSENT_TITLE,
          CONSENT_VERSION,
          body,
          CONSENT_CHECK_1,
          CONSENT_CHECK_2,
          signerLabel,
          signatureDataUrl,
          clientName,
          signedAt,
        ].join("\n"),
      );

      // 동의서 쪽들 + 감사 보고서 쪽
      const consentPages = await renderConsentPages({ orgName, clientName, signerLabel, dateStr, signatureDataUrl });
      const auditPage = renderAuditPage({
        orgName,
        clientName,
        signerLabel,
        workerName,
        signedAt,
        documentHash,
        userAgent,
        strokes,
        ipAddress,
      });

      const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
      [...consentPages, auditPage].forEach((img, i) => {
        if (i > 0) pdf.addPage();
        pdf.addImage(img, "PNG", 0, 0, 210, 297);
      });
      const pdfBase64 = pdf.output("datauristring").split(",")[1];

      toast.loading("Google Drive 저장 중...", { id: tid });

      // Drive 업로드
      const { id: driveId, url: driveUrl } = await uploadToDrive(supabase, {
        name: `${clientCode ?? clientId.slice(0, 8)}_AI기능동의서_${dateStr}.pdf`,
        mimeType: "application/pdf",
        data: pdfBase64,
        folderName: "AI 기능 동의서",
      });

      // clients 테이블 갱신 (기존 업로드 버튼과 동일 컬럼)
      const { error: updateErr } = await supabase
        .from("clients")
        .update({ consent_drive_id: driveId, consent_drive_url: driveUrl })
        .eq("id", clientId);
      if (updateErr) throw updateErr;

      // 감사 로그 저장 (대리 서명이면 signer_name에 대리인 정보를 함께 남긴다)
      let auditSaved = false;
      if (orgId) {
        const { error: logErr } = await supabase.from("consent_audit_logs").insert({
          org_id: orgId,
          client_id: clientId,
          signer_name: proxy ? `${clientName} (대리 서명: ${proxyName.trim()}, ${proxyRel.trim()})` : clientName,
          worker_name: workerName || null,
          signed_at: new Date().toISOString(),
          document_hash: documentHash,
          user_agent: userAgent,
          ip_address: ipAddress !== "-" ? ipAddress : null,
          signature_strokes: strokes,
          drive_file_id: driveId,
          drive_url: driveUrl,
        });
        if (logErr) console.error("[ConsentSignatureDialog] 감사 로그 저장 실패:", logErr);
        else auditSaved = true;
      }

      toast.success("동의서가 저장되었습니다.", { id: tid });
      if (!auditSaved) {
        toast.warning("서명 기록(감사 로그) 저장에 실패했습니다. 동의서 PDF는 저장되었으니 관리자에게 알려 주세요.");
      }
      onComplete(driveUrl);
      onOpenChange(false);
    } catch (err) {
      const msg = (err as Error).message || "알 수 없는 오류";
      console.error("[ConsentSignatureDialog]", err);
      toast.error(`저장 실패: ${msg}`, { id: tid });
      setStep("sign");
    }
  }

  // ── 렌더링 ──────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PenLine className="h-5 w-5" />
            AI 기능 이용 동의서
          </DialogTitle>
          <DialogDescription>
            {step === "read"
              ? "내용을 읽고 두 가지 동의에 체크한 뒤 서명하기를 눌러주세요."
              : "서명란에 자필 서명 후 완료를 눌러주세요."}
          </DialogDescription>
        </DialogHeader>

        {/* ── STEP 1: 동의서 읽기 ── */}
        {step === "read" && (
          <>
            <ScrollArea className="h-64 border rounded-md p-4 text-sm leading-relaxed bg-muted/30">
              <p className="font-bold text-center mb-1 text-base">{CONSENT_TITLE}</p>
              <p className="text-center text-xs text-muted-foreground mb-3">{CONSENT_VERSION}</p>
              <p className="whitespace-pre-wrap text-muted-foreground">{body}</p>
            </ScrollArea>

            <div className="flex items-start gap-2">
              <Checkbox
                id="agree-check-1"
                checked={agreed1}
                onCheckedChange={(v) => setAgreed1(!!v)}
                className="mt-0.5"
              />
              <label htmlFor="agree-check-1" className="text-sm leading-snug cursor-pointer select-none">
                {CONSENT_CHECK_1}
              </label>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="agree-check-2"
                checked={agreed2}
                onCheckedChange={(v) => setAgreed2(!!v)}
                className="mt-0.5"
              />
              <label htmlFor="agree-check-2" className="text-sm leading-snug cursor-pointer select-none">
                {CONSENT_CHECK_2}
              </label>
            </div>

            <div className="rounded-md border p-3 space-y-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <Checkbox
                  id="proxy-check"
                  checked={proxy}
                  onCheckedChange={(v) => setProxy(!!v)}
                />
                대리인(보호자·후견인)이 대신 서명합니다
              </label>
              {proxy && (
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    placeholder="대리인 성명"
                    value={proxyName}
                    onChange={(e) => setProxyName(e.target.value)}
                  />
                  <Input
                    placeholder="대상자와의 관계 (예: 아들)"
                    value={proxyRel}
                    onChange={(e) => setProxyRel(e.target.value)}
                  />
                </div>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              동의하지 않으시려면 서명하지 않고 취소한 뒤, 대상자 관리에서 'AI 기능 활용'을 '거부'로 설정해 주세요.
              동의하지 않아도 복지 서비스 이용에 불이익이 없습니다.
            </p>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                취소
              </Button>
              <Button disabled={!canProceed} onClick={() => setStep("sign")}>
                서명하기
              </Button>
            </div>
          </>
        )}

        {/* ── STEP 2: 자필 서명 ── */}
        {(step === "sign" || step === "uploading") && (
          <>
            <p className="text-sm text-muted-foreground -mt-1">
              {proxy ? `대리인(${proxyName.trim()})이 ` : ""}마우스 또는 손가락으로 서명해주세요.
            </p>

            <div className="border-2 border-dashed border-border rounded-md overflow-hidden bg-white">
              <canvas
                ref={canvasRef}
                width={560}
                height={200}
                className="w-full touch-none cursor-crosshair block"
                style={{ background: "white", height: "clamp(170px, 36dvh, 260px)" }}
                onMouseDown={startDraw}
                onMouseMove={draw}
                onMouseUp={endDraw}
                onMouseLeave={endDraw}
                onTouchStart={startDraw}
                onTouchMove={draw}
                onTouchEnd={endDraw}
              />
            </div>

            {/* 서명을 시작하면 문구만 숨기고 자리는 유지한다(창 높이가 줄면서 서명판이 손가락 아래에서 튀는 것을 막음) */}
            <p className={`text-xs text-muted-foreground text-center -mt-1 transition-opacity ${isEmpty ? "opacity-100" : "opacity-0"}`} aria-hidden={!isEmpty}>
              서명란을 클릭하거나 터치하여 서명하세요.
            </p>

            <div className="flex justify-between items-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={clearSignature}
                disabled={step === "uploading"}
              >
                지우기
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setStep("read")}
                  disabled={step === "uploading"}
                >
                  이전
                </Button>
                <Button
                  disabled={isEmpty || step === "uploading"}
                  onClick={handleUpload}
                >
                  {step === "uploading" ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-1" />
                      저장 중...
                    </>
                  ) : (
                    "서명 완료"
                  )}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
