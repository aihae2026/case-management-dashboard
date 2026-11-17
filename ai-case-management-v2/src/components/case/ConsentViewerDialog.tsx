import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, ExternalLink } from "lucide-react";
import { PdfPagesViewer } from "@/components/PdfPagesViewer";

/**
 * 동의서 PDF 보기. 파일은 Drive에서 비공개라 앱이 권한을 확인한 뒤 받아 온 내용(Blob 주소)을 이 창 안에서 보여 준다.
 * 브라우저 설정 때문에 미리보기가 비어 보이면 '새 탭에서 열기'나 '다운로드'를 쓰면 된다.
 */
export function ConsentViewerDialog({
  url,
  fileName,
  onClose,
}: {
  url: string | null;
  fileName: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!url} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl h-[90dvh] flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle>AI 기능 이용 동의서</DialogTitle>
          <DialogDescription>
            동의서는 비공개로 보관돼서, 앱이 권한을 확인한 뒤 보여 드려요. 화면이 비어 보이면 아래 버튼을 눌러 주세요.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 rounded-md border border-border overflow-hidden bg-muted/30">
          {url && <PdfPagesViewer url={url} />}
        </div>
        <div className="flex justify-end gap-2">
          {url && (
            <>
              <Button asChild variant="outline" size="sm">
                <a href={url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-1" />
                  새 탭에서 열기
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={url} download={fileName}>
                  <Download className="h-4 w-4 mr-1" />
                  다운로드
                </a>
              </Button>
            </>
          )}
          <Button size="sm" onClick={onClose}>
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
