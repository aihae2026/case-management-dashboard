import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  DRIVE_VIEWER_EVENT,
  drivePreviewUrl,
  setDriveViewerReady,
  type DriveViewerRequest,
} from "@/lib/drive-viewer";

/** 앱 어디서든 openDriveFile() 을 부르면 이 창에서 Drive 파일(PDF·이미지·녹음)을 보여 준다. 화면에 한 번만 둔다. */
export function DriveViewerHost() {
  const [req, setReq] = useState<DriveViewerRequest | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => setReq((e as CustomEvent<DriveViewerRequest>).detail);
    window.addEventListener(DRIVE_VIEWER_EVENT, onOpen);
    setDriveViewerReady(true);
    return () => {
      window.removeEventListener(DRIVE_VIEWER_EVENT, onOpen);
      setDriveViewerReady(false);
    };
  }, []);

  const preview = req ? drivePreviewUrl(req.url) : null;

  return (
    <Dialog open={!!req} onOpenChange={(o) => { if (!o) setReq(null); }}>
      <DialogContent className="max-w-4xl h-[90dvh] flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="truncate">{req?.title ?? "파일 보기"}</DialogTitle>
          <DialogDescription>
            화면이 비어 보이면 '새 탭에서 열기'를 눌러 주세요.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 rounded-md border border-border overflow-hidden bg-muted/30">
          {preview && <iframe src={preview} title={req?.title ?? "파일"} className="h-full w-full" allow="autoplay" />}
        </div>
        <div className="flex justify-end gap-2">
          {req && (
            <Button asChild variant="outline" size="sm">
              <a href={req.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4 mr-1" />
                새 탭에서 열기
              </a>
            </Button>
          )}
          <Button size="sm" onClick={() => setReq(null)}>
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
