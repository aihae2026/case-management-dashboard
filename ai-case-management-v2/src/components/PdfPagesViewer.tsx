import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * PDF 보기: 브라우저 내장 PDF 보기(iframe)에 기대지 않고 쪽마다 캔버스로 직접 그린다.
 * - 안드로이드 Chrome은 iframe 안 PDF를 그리지 못하고, 아이폰 Safari는 첫 쪽만 보여서 폰에서는 이 방식이 안전하다.
 * - 쪽은 세로로 이어 붙이고, 화면 폭에 맞춰 그린다(손가락 확대는 브라우저 기본 동작).
 */
export function PdfPagesViewer({ url }: { url: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errMsg, setErrMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => void) | null = null;
    setState("loading");
    (async () => {
      try {
        const box = boxRef.current;
        if (!box) return;
        const buf = await (await fetch(url)).arrayBuffer();
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const task = pdfjs.getDocument({ data: buf });
        destroy = () => { void task.destroy(); };
        const doc = await task.promise;
        if (cancelled) return;
        box.replaceChildren();
        const cssWidth = Math.max(240, Math.floor(box.clientWidth) || 320);
        const dpr = Math.min(window.devicePixelRatio || 1, 2); // 폰에서 메모리를 아끼려고 2배까지만
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const scale = (cssWidth / base.width) * dpr;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = "100%";
          canvas.style.height = "auto";
          canvas.style.display = "block";
          canvas.style.background = "#fff";
          canvas.style.marginBottom = "8px";
          canvas.style.boxShadow = "0 0 0 1px rgba(0,0,0,0.12)";
          canvas.setAttribute("aria-label", `${i}쪽`);
          box.appendChild(canvas);
          await page.render({ canvas, viewport }).promise;
        }
        if (!cancelled) setState("ready");
      } catch (e) {
        if (!cancelled) {
          setErrMsg((e as Error).message || "PDF를 그리지 못했어요.");
          setState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [url]);

  return (
    <div className="relative h-full w-full overflow-y-auto overscroll-contain bg-muted/30 p-2">
      <div ref={boxRef} />
      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground gap-2 pointer-events-none">
          <Loader2 className="h-4 w-4 animate-spin" />
          동의서를 불러오는 중…
        </div>
      )}
      {state === "error" && (
        <p className="p-4 text-sm text-destructive">
          화면에 표시하지 못했어요({errMsg}). 아래 '새 탭에서 열기'나 '다운로드'를 이용해 주세요.
        </p>
      )}
    </div>
  );
}
