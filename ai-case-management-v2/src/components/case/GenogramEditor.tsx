/**
 * GenogramEditor — 가계도 / 관계망 그리기 편집기
 *
 * 두 레이어 구조:
 *   1. bgRef (오프스크린 캔버스) — 기존 이미지(저장된 PNG) + 펜/지우개 픽셀 획
 *   2. objects (React 상태) — 도형·선·텍스트 벡터 오브젝트 (개별 선택·이동 가능)
 *
 * 메인 캔버스(canvasRef) = bgRef + objects 합성 렌더링
 * 저장 = 두 레이어를 합쳐 PNG data URL로 export
 */
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Pencil, Eraser, Undo2, Trash2, Square, Circle,
  Minus, X, Hand, Type, MousePointer2,
} from "lucide-react";

// ── 타입 정의 ─────────────────────────────────────────────────────────────────

type Tool = "select" | "pen" | "square" | "circle" | "deceased" | "line" | "text" | "move" | "eraser";
type DeathShape = "square" | "circle";
type LineType =
  | "결혼" | "별거" | "별거후재결합" | "이혼" | "이혼후재결합" | "동거가족" | "내연"
  | "친밀" | "갈등" | "소원" | "단절";
type Pt = { x: number; y: number };

type ShapeObj = {
  id: string; type: "shape";
  kind: "square" | "circle" | "deceased"; deathKind: "square" | "circle";
  x: number; y: number; w: number; h: number;
};
type LineObj = { id: string; type: "line"; lineType: LineType; x1: number; y1: number; x2: number; y2: number };
type TextObj = { id: string; type: "text"; text: string; fontSize: number; x: number; y: number };
type GenObj = ShapeObj | LineObj | TextObj;

// ── 상수 ─────────────────────────────────────────────────────────────────────

const W = 700;
const H = 480;

const LINE_TYPES_PARTNER: { value: LineType; label: string }[] = [
  { value: "결혼",        label: "결혼 (실선)" },
  { value: "별거",        label: "별거 (사선 1)" },
  { value: "별거후재결합", label: "별거 후 재결합" },
  { value: "이혼",        label: "이혼 (사선 2)" },
  { value: "이혼후재결합", label: "이혼 후 재결합" },
  { value: "동거가족",     label: "동거가족 (점선)" },
  { value: "내연",        label: "내연관계 (짧은 점선)" },
];
const LINE_TYPES_RELATION: { value: LineType; label: string }[] = [
  { value: "친밀", label: "친밀 (이중선)" },
  { value: "갈등", label: "갈등 (지그재그)" },
  { value: "소원", label: "소원 (긴 점선)" },
  { value: "단절", label: "단절 (끊김선)" },
];

const TOOLS: { key: Tool; label: string; icon: React.ReactNode }[] = [
  { key: "select",   label: "선택·이동",    icon: <MousePointer2 className="h-4 w-4" /> },
  { key: "pen",      label: "펜",           icon: <Pencil className="h-4 w-4" /> },
  { key: "square",   label: "남성 □",       icon: <Square className="h-4 w-4" /> },
  { key: "circle",   label: "여성 ○",       icon: <Circle className="h-4 w-4" /> },
  { key: "deceased", label: "사망 ⊠",       icon: <X className="h-4 w-4" /> },
  { key: "line",     label: "선",           icon: <Minus className="h-4 w-4" /> },
  { key: "text",     label: "텍스트",        icon: <Type className="h-4 w-4" /> },
  { key: "move",     label: "전체이동(손)",  icon: <Hand className="h-4 w-4" /> },
  { key: "eraser",   label: "지우개",        icon: <Eraser className="h-4 w-4" /> },
];

// ── 유틸 함수 ─────────────────────────────────────────────────────────────────

function genId() { return Math.random().toString(36).slice(2, 8); }

function shiftObj(obj: GenObj, dx: number, dy: number): GenObj {
  if (obj.type === "shape") return { ...obj, x: obj.x + dx, y: obj.y + dy };
  if (obj.type === "line")  return { ...obj, x1: obj.x1 + dx, y1: obj.y1 + dy, x2: obj.x2 + dx, y2: obj.y2 + dy };
  return { ...obj, x: obj.x + dx, y: obj.y + dy }; // text
}

/** 오브젝트 클릭 판정 */
function hitTest(obj: GenObj, p: Pt): boolean {
  const M = 8;
  if (obj.type === "shape") {
    return p.x >= obj.x - M && p.x <= obj.x + obj.w + M &&
           p.y >= obj.y - M && p.y <= obj.y + obj.h + M;
  }
  if (obj.type === "text") {
    const w = obj.text.length * obj.fontSize * 0.65;
    return p.x >= obj.x - M && p.x <= obj.x + w + M &&
           p.y >= obj.y - obj.fontSize - M && p.y <= obj.y + obj.fontSize * 0.5 + M;
  }
  // line: 점-선분 거리
  const dx = obj.x2 - obj.x1, dy = obj.y2 - obj.y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - obj.x1, p.y - obj.y1) < M + 4;
  const t = Math.max(0, Math.min(1, ((p.x - obj.x1) * dx + (p.y - obj.y1) * dy) / len2));
  return Math.hypot(p.x - obj.x1 - t * dx, p.y - obj.y1 - t * dy) < M + 4;
}

// ── 오브젝트 렌더링 ───────────────────────────────────────────────────────────

function drawObjOnCtx(ctx: CanvasRenderingContext2D, obj: GenObj, selected: boolean) {
  ctx.save();
  const stroke = selected ? "#2563eb" : "#111827";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = selected ? 3 : 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([]);

  if (obj.type === "text") {
    ctx.fillStyle = selected ? "#2563eb" : "#111827";
    ctx.font = `${obj.fontSize}px sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(obj.text, obj.x, obj.y);
    if (selected) {
      const tw = obj.text.length * obj.fontSize * 0.65;
      const th = obj.fontSize * 1.4;
      ctx.strokeStyle = "#2563eb80";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(obj.x - 2, obj.y - th / 2, tw + 4, th);
    }
    ctx.restore();
    return;
  }

  if (obj.type === "shape") {
    const { x, y, w, h, kind, deathKind } = obj;
    if (kind === "square") {
      ctx.strokeRect(x, y, w, h);
    } else if (kind === "circle") {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      // deceased
      if (deathKind === "circle") {
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.strokeRect(x, y, w, h);
      }
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x + w, y + h);
      ctx.moveTo(x + w, y); ctx.lineTo(x, y + h);
      ctx.stroke();
    }
    if (selected) {
      ctx.strokeStyle = "#2563eb60";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x - 4, y - 4, w + 8, h + 8);
    }
    ctx.restore();
    return;
  }

  // ── 선(line) ─────────────────────────────────────────────────────────────
  const { x1, y1, x2, y2, lineType } = obj;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const perp  = angle + Math.PI / 2;

  if (lineType === "친밀") {
    // 이중 평행선
    const off = 3.5;
    ctx.beginPath();
    ctx.moveTo(x1 + Math.cos(perp) * off, y1 + Math.sin(perp) * off);
    ctx.lineTo(x2 + Math.cos(perp) * off, y2 + Math.sin(perp) * off);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1 - Math.cos(perp) * off, y1 - Math.sin(perp) * off);
    ctx.lineTo(x2 - Math.cos(perp) * off, y2 - Math.sin(perp) * off);
    ctx.stroke();

  } else if (lineType === "갈등") {
    // 지그재그선
    const len = Math.hypot(x2 - x1, y2 - y1);
    const seg = 14;
    const n   = Math.max(1, Math.round(len / seg));
    const amp = 6;
    ctx.beginPath();
    for (let i = 0; i <= n * 2; i++) {
      const t = i / (n * 2);
      const px = x1 + (x2 - x1) * t;
      const py = y1 + (y2 - y1) * t;
      const side = i === 0 || i === n * 2 ? 0 : (i % 2 === 1 ? amp : -amp);
      const qx = px + Math.cos(perp) * side;
      const qy = py + Math.sin(perp) * side;
      i === 0 ? ctx.moveTo(qx, qy) : ctx.lineTo(qx, qy);
    }
    ctx.stroke();

  } else if (lineType === "소원") {
    // 긴 점선
    ctx.setLineDash([14, 9]);
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);

  } else if (lineType === "단절") {
    // 선 + 양 끝에서 일정 거리 안쪽에 수직 표시선
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.stroke();
    const markOff = 14; // 끝에서 안쪽으로
    const markLen = 8;
    for (const ep of [{ x: x1, y: y1, dir: 1 }, { x: x2, y: y2, dir: -1 }]) {
      const hx = ep.x + Math.cos(angle) * ep.dir * markOff;
      const hy = ep.y + Math.sin(angle) * ep.dir * markOff;
      ctx.beginPath();
      ctx.moveTo(hx + Math.cos(perp) * markLen, hy + Math.sin(perp) * markLen);
      ctx.lineTo(hx - Math.cos(perp) * markLen, hy - Math.sin(perp) * markLen);
      ctx.stroke();
    }

  } else {
    // 결혼/별거/이혼/동거가족/내연
    const dashed = lineType === "동거가족";
    const shortDashed = lineType === "내연";
    ctx.setLineDash(dashed ? [7, 5] : shortDashed ? [3, 4] : []);
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 상태 표시 (중간 사선·재결합 다리)
    const slash = (ox: number) => {
      ctx.beginPath();
      ctx.moveTo(cx + ox - 6, cy + 7);
      ctx.lineTo(cx + ox + 6, cy - 7);
      ctx.stroke();
    };
    const bridge = () => {
      ctx.beginPath();
      ctx.moveTo(cx - 9, cy - 9);
      ctx.lineTo(cx, cy - 15);
      ctx.lineTo(cx + 9, cy - 9);
      ctx.stroke();
    };
    if (lineType === "별거")           slash(0);
    else if (lineType === "이혼")      { slash(-5); slash(5); }
    else if (lineType === "별거후재결합") { slash(0);  bridge(); }
    else if (lineType === "이혼후재결합") { slash(-5); slash(5); bridge(); }
  }

  ctx.restore();
}

/** 드래그 중 미리보기 렌더링 (선택 도형) */
function drawPreview(ctx: CanvasRenderingContext2D, t: Tool, sp: Pt, ep: Pt, lineType: LineType, deathKind: DeathShape) {
  if (t === "line") {
    const prev: LineObj = { id: "p", type: "line", lineType, x1: sp.x, y1: sp.y, x2: ep.x, y2: ep.y };
    drawObjOnCtx(ctx, prev, false);
    return;
  }
  if (t === "square" || t === "circle" || t === "deceased") {
    const x = Math.min(sp.x, ep.x), y = Math.min(sp.y, ep.y);
    const w = Math.abs(ep.x - sp.x), h = Math.abs(ep.y - sp.y);
    const prev: ShapeObj = { id: "p", type: "shape", kind: t, deathKind, x, y, w, h };
    drawObjOnCtx(ctx, prev, true);
  }
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export function GenogramEditor({
  open,
  onOpenChange,
  value,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  value: string | null;
  onSave: (dataUrl: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgRef     = useRef<HTMLCanvasElement | null>(null); // 오프스크린 배경 캔버스

  // ── 도구 상태 ──
  const [tool,       setTool]       = useState<Tool>("select");
  const [deathShape, setDeathShape] = useState<DeathShape>("square");
  const [lineType,   setLineType]   = useState<LineType>("결혼");
  const [textValue,  setTextValue]  = useState("");
  const [fontSize,   setFontSize]   = useState(14);

  // ── 벡터 오브젝트 상태 ──
  const [objects,    setObjects]    = useState<GenObj[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── 이벤트 핸들러용 ref (stale closure 방지) ──
  const objectsRef    = useRef<GenObj[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  const toolRef       = useRef<Tool>("select");
  const lineTypeRef   = useRef<LineType>("결혼");
  const deathShapeRef = useRef<DeathShape>("square");
  const fontSizeRef   = useRef(14);

  useEffect(() => { objectsRef.current    = objects;    }, [objects]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { toolRef.current       = tool;       }, [tool]);
  useEffect(() => { lineTypeRef.current   = lineType;   }, [lineType]);
  useEffect(() => { deathShapeRef.current = deathShape; }, [deathShape]);
  useEffect(() => { fontSizeRef.current   = fontSize;   }, [fontSize]);

  // ── 드래그 ref ──
  const drawing        = useRef(false);
  const startPt        = useRef<Pt | null>(null);
  // select 도구 드래그
  const dragOrig       = useRef<GenObj | null>(null);
  const dragStartPt    = useRef<Pt | null>(null);
  const dragCurrent    = useRef<GenObj | null>(null);
  // move(손바닥) 도구 드래그
  const moveDrag = useRef<{ bgData: ImageData; objs: GenObj[]; sp: Pt } | null>(null);

  // ── 실행취소 스택 ──
  type UndoEntry = { bgData: ImageData; objects: GenObj[] };
  const undoStack = useRef<UndoEntry[]>([]);

  // ── 배경 캔버스 초기화 (마운트 1회) ──
  useEffect(() => {
    const bg = document.createElement("canvas");
    bg.width = W; bg.height = H;
    const ctx = bg.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    bgRef.current = bg;
  }, []);

  // ── 다이얼로그 열림 시 초기화 (수정 데이터 유지) ──
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // setTimeout(0) — 다이얼로그 DOM이 완전히 마운트된 뒤 실행
    const t = setTimeout(() => {
      if (cancelled) return;
      const bg = bgRef.current;
      if (!bg) return;
      const bgCtx = bg.getContext("2d")!;
      bgCtx.fillStyle = "#ffffff";
      bgCtx.fillRect(0, 0, W, H);
      undoStack.current = [];
      objectsRef.current = [];
      setObjects([]);
      setSelectedId(null);
      selectedIdRef.current = null;

      if (value) {
        const img = new Image();
        img.onload = () => {
          if (cancelled) return;
          bgCtx.drawImage(img, 0, 0, W, H);
          refreshMain([], null);
        };
        img.onerror = () => refreshMain([], null);
        img.src = value;
      } else {
        refreshMain([], null);
      }
    }, 0);
    return () => { cancelled = true; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]); // value 의존성 제외: 저장 후 value 변경 시 캔버스가 초기화되는 것을 막음

  // ── objects/selectedId 변경 시 캔버스 갱신 ──
  useEffect(() => {
    refreshMain(objects, selectedId);
  }, [objects, selectedId]);

  // ── 렌더링 함수 ──
  function refreshMain(objs: GenObj[], selId: string | null) {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    if (bgRef.current) ctx.drawImage(bgRef.current, 0, 0);
    for (const obj of objs) drawObjOnCtx(ctx, obj, obj.id === selId);
  }

  // ── 실행취소 ──
  function pushUndo() {
    const bg = bgRef.current;
    if (!bg) return;
    const bgCtx = bg.getContext("2d");
    if (!bgCtx) return;
    const bgData = bgCtx.getImageData(0, 0, W, H);
    undoStack.current.push({ bgData, objects: objectsRef.current.map(o => ({ ...o })) });
    if (undoStack.current.length > 30) undoStack.current.shift();
  }

  function undo() {
    const entry = undoStack.current.pop();
    if (!entry) return;
    const bg = bgRef.current;
    if (bg) bg.getContext("2d")?.putImageData(entry.bgData, 0, 0);
    setObjects(entry.objects);
    setSelectedId(null);
  }

  function clearAll() {
    pushUndo();
    const bg = bgRef.current;
    if (bg) {
      const bgCtx = bg.getContext("2d")!;
      bgCtx.fillStyle = "#ffffff";
      bgCtx.fillRect(0, 0, W, H);
    }
    setObjects([]);
    setSelectedId(null);
  }

  // ── 좌표 변환 ──
  function pos(e: React.PointerEvent): Pt {
    const cv = canvasRef.current!;
    const r  = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
  }

  // ── 포인터 다운 ──
  function down(e: React.PointerEvent) {
    canvasRef.current?.setPointerCapture(e.pointerId);
    const p = pos(e);
    const t = toolRef.current;

    // 텍스트: 클릭 위치에 텍스트 오브젝트 추가
    if (t === "text") {
      const txt = textValue.trim();
      if (!txt) return;
      pushUndo();
      const id = genId();
      const obj: TextObj = { id, type: "text", text: txt, fontSize: fontSizeRef.current, x: p.x, y: p.y };
      const newObjs = [...objectsRef.current, obj];
      setObjects(newObjs);
      setSelectedId(id);
      return;
    }

    // 선택·이동 도구
    if (t === "select") {
      const hit = [...objectsRef.current].reverse().find(o => hitTest(o, p));
      if (hit) {
        setSelectedId(hit.id);
        selectedIdRef.current = hit.id;
        dragOrig.current    = { ...hit } as GenObj;
        dragStartPt.current = p;
        dragCurrent.current = null;
      } else {
        setSelectedId(null);
        selectedIdRef.current = null;
      }
      return;
    }

    // 전체이동 도구
    if (t === "move") {
      const bg = bgRef.current;
      if (!bg) return;
      const bgCtx = bg.getContext("2d");
      if (!bgCtx) return;
      pushUndo();
      moveDrag.current = {
        bgData: bgCtx.getImageData(0, 0, W, H),
        objs:   objectsRef.current.map(o => ({ ...o })),
        sp:     p,
      };
      drawing.current = true;
      return;
    }

    // 지우개: 오브젝트 위 클릭 → 오브젝트 전체 삭제 / 빈 곳 클릭 → 배경 브러시 지우개
    if (t === "eraser") {
      const hit = [...objectsRef.current].reverse().find(o => hitTest(o, p));
      if (hit) {
        pushUndo();
        const newObjs = objectsRef.current.filter(o => o.id !== hit.id);
        objectsRef.current = newObjs; // 즉시 ref 동기화
        setObjects(newObjs);
        refreshMain(newObjs, selectedIdRef.current);
        return; // 오브젝트 삭제 → 브러시 모드 시작 안 함
      }
      // 오브젝트 없는 곳 → 배경 브러시 지우개
      pushUndo();
      drawing.current = true;
      const bgCtxE = bgRef.current?.getContext("2d");
      if (!bgCtxE) return;
      bgCtxE.lineCap    = "round";
      bgCtxE.lineJoin   = "round";
      bgCtxE.lineWidth  = 22;
      bgCtxE.strokeStyle = "#ffffff";
      bgCtxE.beginPath();
      bgCtxE.moveTo(p.x, p.y);
      return;
    }

    // 펜
    if (t === "pen") {
      pushUndo();
      drawing.current = true;
      const bgCtx = bgRef.current?.getContext("2d");
      if (!bgCtx) return;
      bgCtx.lineCap    = "round";
      bgCtx.lineJoin   = "round";
      bgCtx.lineWidth  = 2.5;
      bgCtx.strokeStyle = "#111827";
      bgCtx.beginPath();
      bgCtx.moveTo(p.x, p.y);
      return;
    }

    // 도형 / 선 드래그 시작
    pushUndo();
    drawing.current = true;
    startPt.current = p;
  }

  // ── 포인터 이동 ──
  function ptrMove(e: React.PointerEvent) {
    const p = pos(e);
    const t = toolRef.current;

    // 선택 오브젝트 드래그
    if (t === "select") {
      if (!dragOrig.current || !dragStartPt.current) return;
      const dx = p.x - dragStartPt.current.x;
      const dy = p.y - dragStartPt.current.y;
      dragCurrent.current = shiftObj(dragOrig.current, dx, dy);
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      if (bgRef.current) ctx.drawImage(bgRef.current, 0, 0);
      for (const obj of objectsRef.current) {
        const isSel = obj.id === selectedIdRef.current;
        drawObjOnCtx(ctx, isSel ? dragCurrent.current! : obj, isSel);
      }
      return;
    }

    // 전체이동 드래그
    if (t === "move" && moveDrag.current) {
      const dx = Math.round(p.x - moveDrag.current.sp.x);
      const dy = Math.round(p.y - moveDrag.current.sp.y);
      const bg = bgRef.current;
      if (bg) {
        const bgCtx = bg.getContext("2d")!;
        bgCtx.fillStyle = "#ffffff";
        bgCtx.fillRect(0, 0, W, H);
        bgCtx.putImageData(moveDrag.current.bgData, dx, dy);
      }
      const tempObjs = moveDrag.current.objs.map(o => shiftObj(o, dx, dy));
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      if (bgRef.current) ctx.drawImage(bgRef.current, 0, 0);
      for (const obj of tempObjs) drawObjOnCtx(ctx, obj, false);
      return;
    }

    if (!drawing.current) return;

    // 펜 / 지우개
    if (t === "pen" || t === "eraser") {
      const bgCtx = bgRef.current?.getContext("2d");
      if (!bgCtx) return;
      bgCtx.lineTo(p.x, p.y);
      bgCtx.stroke();
      refreshMain(objectsRef.current, selectedIdRef.current);
      return;
    }

    // 도형·선 미리보기
    if (!startPt.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    if (bgRef.current) ctx.drawImage(bgRef.current, 0, 0);
    for (const obj of objectsRef.current) drawObjOnCtx(ctx, obj, false);
    drawPreview(ctx, t, startPt.current, p, lineTypeRef.current, deathShapeRef.current);
  }

  // ── 포인터 업 ──
  function up(e: React.PointerEvent) {
    const p = pos(e);
    const t = toolRef.current;

    // 선택 드래그 확정
    if (t === "select") {
      if (dragCurrent.current && selectedIdRef.current) {
        const finalObj = dragCurrent.current;
        const selId    = selectedIdRef.current;
        setObjects(prev => prev.map(o => o.id === selId ? finalObj : o));
      }
      dragOrig.current    = null;
      dragStartPt.current = null;
      dragCurrent.current = null;
      drawing.current     = false;
      return;
    }

    // 전체이동 확정
    if (t === "move" && moveDrag.current) {
      const dx = Math.round(p.x - moveDrag.current.sp.x);
      const dy = Math.round(p.y - moveDrag.current.sp.y);
      setObjects(moveDrag.current.objs.map(o => shiftObj(o, dx, dy)));
      moveDrag.current = null;
      drawing.current  = false;
      return;
    }

    if (!drawing.current) return;
    drawing.current = false;

    if (t === "pen" || t === "eraser") {
      startPt.current = null;
      return;
    }

    if (!startPt.current) return;
    const sp = startPt.current;
    startPt.current = null;

    const dx = p.x - sp.x, dy = p.y - sp.y;
    const MIN = 5;
    let newObj: GenObj | null = null;
    const id = genId();

    if (t === "square" || t === "circle" || t === "deceased") {
      if (Math.abs(dx) < MIN && Math.abs(dy) < MIN) {
        // 너무 작으면 취소 — undo 스택에 이미 push했으므로 pop
        undoStack.current.pop();
        refreshMain(objectsRef.current, selectedIdRef.current);
        return;
      }
      const x = Math.min(sp.x, p.x), y = Math.min(sp.y, p.y);
      const w = Math.abs(dx), h = Math.abs(dy);
      newObj = { id, type: "shape", kind: t as "square"|"circle"|"deceased", deathKind: deathShapeRef.current, x, y, w, h };
    } else if (t === "line") {
      if (Math.hypot(dx, dy) < MIN) {
        undoStack.current.pop();
        refreshMain(objectsRef.current, selectedIdRef.current);
        return;
      }
      newObj = { id, type: "line", lineType: lineTypeRef.current, x1: sp.x, y1: sp.y, x2: p.x, y2: p.y };
    }

    if (newObj) {
      const newObjs = [...objectsRef.current, newObj];
      setObjects(newObjs);
      setSelectedId(id);
    } else {
      refreshMain(objectsRef.current, selectedIdRef.current);
    }
  }

  // ── 저장 ──
  function save() {
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const ctx = out.getContext("2d")!;
    if (bgRef.current) ctx.drawImage(bgRef.current, 0, 0);
    for (const obj of objectsRef.current) drawObjOnCtx(ctx, obj, false);
    onSave(out.toDataURL("image/png"));
    onOpenChange(false);
  }

  // ── JSX ──────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[760px]">
        <DialogHeader>
          <DialogTitle>가계도 그리기</DialogTitle>
          <DialogDescription>
            <b>선택·이동</b>으로 개별 도형·선·텍스트를 선택해 위치를 조정할 수 있습니다.
            남성(□)·여성(○)·사망(⊠) 도형과 부부관계선(결혼·별거·이혼)·관계선(친밀·갈등·소원·단절)으로
            가계도·관계망을 그리세요.
          </DialogDescription>
        </DialogHeader>

        {/* 도구 모음 */}
        <div className="flex flex-wrap items-center gap-1">
          {TOOLS.map((t) => (
            <Button
              key={t.key}
              type="button"
              size="sm"
              variant={tool === t.key ? "default" : "outline"}
              onClick={() => setTool(t.key)}
              title={t.label}
            >
              {t.icon}
              <span className="ml-1 hidden sm:inline">{t.label}</span>
            </Button>
          ))}
          <div className="h-5 w-px bg-border mx-1" />
          <Button type="button" size="sm" variant="ghost" onClick={undo}>
            <Undo2 className="h-4 w-4" />
            <span className="ml-1 hidden sm:inline">되돌리기</span>
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={clearAll}>
            <Trash2 className="h-4 w-4" />
            <span className="ml-1 hidden sm:inline">전체지우기</span>
          </Button>
        </div>

        {/* 도구별 옵션 */}
        {(tool === "deceased" || tool === "line" || tool === "text") && (
          <div className="flex flex-wrap items-center gap-2 text-xs rounded-md bg-muted/40 px-3 py-2">
            {tool === "deceased" && (
              <>
                <span className="text-muted-foreground font-medium">사망 도형:</span>
                <Select value={deathShape} onValueChange={(v) => setDeathShape(v as DeathShape)}>
                  <SelectTrigger className="h-8 w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="square">□ 남성(네모)</SelectItem>
                    <SelectItem value="circle">○ 여성(동그라미)</SelectItem>
                  </SelectContent>
                </Select>
              </>
            )}

            {tool === "line" && (
              <>
                <span className="text-muted-foreground font-medium">선 종류:</span>
                <Select value={lineType} onValueChange={(v) => setLineType(v as LineType)}>
                  <SelectTrigger className="h-8 w-52">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel className="text-[10px]">── 부부·가족 관계 ──</SelectLabel>
                      {LINE_TYPES_PARTNER.map((l) => (
                        <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                      ))}
                    </SelectGroup>
                    <SelectGroup>
                      <SelectLabel className="text-[10px]">── 관계 상태 ──</SelectLabel>
                      {LINE_TYPES_RELATION.map((l) => (
                        <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </>
            )}

            {tool === "text" && (
              <>
                <span className="text-muted-foreground font-medium">텍스트:</span>
                <Input
                  className="h-8 w-48"
                  value={textValue}
                  onChange={(e) => setTextValue(e.target.value)}
                  placeholder="예: m.1980 / 홍길동 (70)"
                  onKeyDown={(e) => e.stopPropagation()}
                />
                <span className="text-muted-foreground font-medium">크기:</span>
                <Input
                  type="number"
                  className="h-8 w-16"
                  value={fontSize}
                  min={8}
                  max={36}
                  onChange={(e) => setFontSize(Math.max(8, Math.min(36, Number(e.target.value) || 14)))}
                />
                <span className="text-muted-foreground">pt · 캔버스 클릭으로 배치</span>
              </>
            )}
          </div>
        )}

        {/* 캔버스 */}
        <div className="rounded-md border border-border overflow-hidden bg-white">
          <canvas
            ref={canvasRef}
            width={W}
            height={H}
            className={`block w-full h-auto ${
              tool === "move"   ? "cursor-grab" :
              tool === "select" ? "cursor-default" :
              tool === "eraser" ? "cursor-cell" :
              "cursor-crosshair"
            }`}
            style={{ touchAction: "none", aspectRatio: `${W} / ${H}` }}
            onPointerDown={down}
            onPointerMove={ptrMove}
            onPointerUp={up}
            onPointerLeave={up}
            onPointerCancel={up}
          />
        </div>

        {/* 범례 */}
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          <b>범례</b> □남성 · ○여성 · ⊠사망 ·{" "}
          <span className="inline-block border-b-2 border-gray-700 w-5 align-middle" /> 결혼 ·{" "}
          <span className="inline-block border-b-2 border-dotted border-gray-700 w-5 align-middle" /> 동거가족 ·{" "}
          <span className="font-bold">══</span> 친밀 ·{" "}
          <span className="font-bold">∿∿</span> 갈등 ·{" "}
          <span className="tracking-widest text-gray-500">- - -</span> 소원 ·{" "}
          <span className="font-bold">⊣⊢</span> 단절 ·{" "}
          <b>선택·이동</b>으로 개별 요소 이동 · <b>전체이동(손)</b>으로 전체 이동
        </p>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            className="mr-auto text-destructive"
            onClick={() => { onSave(null); onOpenChange(false); }}
          >
            가계도 삭제
          </Button>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button type="button" onClick={save}>
            저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
