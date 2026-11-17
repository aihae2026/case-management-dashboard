import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  BookOpen,
  MessageSquarePlus,
  Sparkles,
  Upload,
  Bot,
  Search,
  Calendar,
  Users,
  ShieldCheck,
  AlertTriangle,
  HelpCircle,
  ChevronRight,
  Smartphone,
} from "lucide-react";

interface UserGuideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: "user" | "admin";
}

function SectionTitle({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-base font-semibold mb-3 mt-5 first:mt-0">
      <div className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      {children}
    </div>
  );
}

function StepList({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-2 ml-1">
      {steps.map((step, i) => (
        <li key={i} className="flex items-start gap-2.5 text-sm">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-[11px] font-bold mt-0.5">
            {i + 1}
          </span>
          <span className="leading-relaxed text-foreground/90">{step}</span>
        </li>
      ))}
    </ol>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-left hover:bg-accent/50 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{q}</span>
        <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 text-sm text-muted-foreground leading-relaxed border-t border-border bg-muted/20">
          {a}
        </div>
      )}
    </div>
  );
}

function NoteBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-300 leading-relaxed">
      {children}
    </div>
  );
}

function UserGuideContent() {
  return (
    <div className="space-y-1 text-sm">
      {/* 앱 설치 */}
      <SectionTitle icon={Smartphone}>앱으로 설치하기</SectionTitle>
      <p className="text-muted-foreground leading-relaxed ml-1 mb-2">
        홈 화면에 추가하면 별도 앱처럼 바로 실행할 수 있습니다. 설치 후에도 항상 최신 버전이 자동 반영됩니다.
      </p>
      <div className="grid grid-cols-1 gap-2 ml-1">
        {[
          { device: "아이폰 (Safari)", steps: "하단 공유 버튼 → '홈 화면에 추가'" },
          { device: "안드로이드 (Chrome)", steps: "메뉴(⋮) → '앱 설치' 또는 '홈 화면에 추가'" },
          { device: "PC (Chrome)", steps: "주소창 오른쪽 설치 아이콘(⊕) 클릭" },
        ].map(({ device, steps }) => (
          <div key={device} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm">
            <span className="font-medium shrink-0 text-foreground">{device}</span>
            <span className="text-muted-foreground">{steps}</span>
          </div>
        ))}
      </div>

      {/* 빠른 시작 */}
      <SectionTitle icon={MessageSquarePlus}>상담기록 남기기 — 5단계</SectionTitle>
      <StepList steps={[
        "상단 탭 중 [상담 및 제공이력] 클릭",
        "오른쪽 상단 [+ 상담기록 추가] 버튼 클릭",
        "대상자 선택 후 상담 일시·내용 입력",
        "선택사항: [AI로 다듬기] 버튼으로 요약문 자동 생성",
        "[저장] 클릭 — 상담기록 목록에 즉시 반영됩니다",
      ]} />

      {/* 주요 기능 */}
      <SectionTitle icon={Sparkles}>AI 다듬기</SectionTitle>
      <p className="text-muted-foreground leading-relaxed ml-1">
        상담기록 작성 후 [AI로 다듬기] 버튼을 누르면 AI가 <strong>주요 호소 / 관찰된 상태 / 욕구 및 지원 필요사항 / 다음 조치</strong> 4개 항목으로 자동 정리해 드립니다. 초안을 그대로 쓰거나 수정한 뒤 저장하세요.
      </p>

      <SectionTitle icon={Upload}>재사정 파일 업로드</SectionTitle>
      <p className="text-muted-foreground leading-relaxed ml-1">
        상담기록 입력창에서 PDF·이미지를 첨부하면 AI가 문서 내용을 읽어 상담기록 초안을 자동으로 작성합니다. 촉박한 행정 업무에 유용합니다.
      </p>

      <SectionTitle icon={Bot}>자원 배분 AI 도우미</SectionTitle>
      <p className="text-muted-foreground leading-relaxed ml-1">
        상담기록에서 💬 아이콘을 누르면 채팅창이 열립니다. "홍길동 씨에게 맞는 자원이 있을까요?" 처럼 질문하면 최근 1년 상담·제공이력을 바탕으로 적합한 서비스를 추천합니다.
      </p>

      <SectionTitle icon={Search}>키워드 검색</SectionTitle>
      <p className="text-muted-foreground leading-relaxed ml-1">
        [상담 및 제공이력] 탭 오른쪽 상단 🔍 버튼을 누르고 단어를 입력하면 전체 상담기록에서 해당 키워드가 포함된 건을 빠르게 찾을 수 있습니다.
      </p>

      <SectionTitle icon={Calendar}>달력 보기</SectionTitle>
      <p className="text-muted-foreground leading-relaxed ml-1">
        [전체 현황] 탭에서 달력 아이콘을 누르면 월별 상담 건수와 공휴일을 함께 확인할 수 있습니다.
      </p>

      {/* FAQ */}
      <SectionTitle icon={HelpCircle}>자주 묻는 질문</SectionTitle>
      <div className="space-y-2">
        <FaqItem
          q="AI가 이상한 내용을 생성했어요."
          a="AI 결과물은 반드시 사람이 검토 후 사용하세요. 저장 전에 내용을 직접 수정할 수 있습니다. 생성된 내용이 실제 상담 내용과 다르다면 저장하지 말고 직접 입력해 주세요."
        />
        <FaqItem
          q="대상자를 실수로 잘못 연결했어요."
          a="상담기록 수정 화면에서 대상자를 다시 선택해 저장하면 됩니다. 대상자 삭제는 [대상자 관리] 탭에서 가능합니다."
        />
        <FaqItem
          q="다른 담당자가 내 기록을 볼 수 있나요?"
          a="같은 기관 내 모든 담당자는 상담기록을 공유합니다. 개인정보가 포함된 내용 입력 시 유의해 주세요."
        />
        <FaqItem
          q="앱이 느리거나 오류가 나요."
          a="페이지를 새로고침(로고 클릭)해 보세요. 계속 문제가 생기면 기관 관리자에게 문의하세요."
        />
      </div>

      {/* 주의사항 */}
      <SectionTitle icon={AlertTriangle}>이용 시 주의사항</SectionTitle>
      <div className="space-y-2">
        <NoteBox>AI가 생성한 내용은 <strong>초안</strong>입니다. 저장 전 반드시 내용을 확인하세요.</NoteBox>
        <NoteBox>이름·연락처·주민번호 등 민감 개인정보는 상담기록에 직접 입력하지 않는 것을 권장합니다.</NoteBox>
        <NoteBox>서비스는 기관 단위로 운영됩니다. 퇴직 시 관리자에게 계정 처리를 요청하세요.</NoteBox>
      </div>
    </div>
  );
}

function AdminGuideContent() {
  return (
    <div className="space-y-1 text-sm">
      {/* 담당자 등록 */}
      <SectionTitle icon={Users}>담당자 등록하기 — 5단계</SectionTitle>
      <StepList steps={[
        "[기관 멤버] 탭 → 상단 [기관코드 복사] 버튼으로 코드 확인",
        "신규 담당자에게 기관코드 공유 (문자·메신저 등)",
        "담당자가 서비스 접속 → [신규 등록] → 기관코드 입력 → Google 로그인",
        "[기관 멤버] 탭에 '승인 대기' 상태로 표시됨",
        "[승인] 버튼 클릭 → 담당자가 즉시 사용 가능",
      ]} />

      {/* 권한 표 */}
      <SectionTitle icon={ShieldCheck}>역할별 권한</SectionTitle>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left px-3 py-2 font-medium">기능</th>
              <th className="text-center px-3 py-2 font-medium">일반 담당자</th>
              <th className="text-center px-3 py-2 font-medium">관리자</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {[
              ["상담기록 조회·작성", "✓", "✓"],
              ["대상자 등록·수정", "✓", "✓"],
              ["AI 기능 사용", "✓", "✓"],
              ["담당자 승인·역할 변경", "✗", "✓"],
              ["담당자 내보내기", "✗", "✓"],
              ["기관 정보 수정", "✗", "✓"],
            ].map(([feat, user, admin]) => (
              <tr key={feat} className="hover:bg-muted/20 transition-colors">
                <td className="px-3 py-2 text-foreground/80">{feat}</td>
                <td className="px-3 py-2 text-center">{user === "✓" ? <span className="text-green-600">✓</span> : <span className="text-muted-foreground">✗</span>}</td>
                <td className="px-3 py-2 text-center">{admin === "✓" ? <span className="text-green-600">✓</span> : <span className="text-muted-foreground">✗</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 꼭 챙겨야 할 것들 */}
      <SectionTitle icon={AlertTriangle}>꼭 챙겨야 할 것들</SectionTitle>
      <div className="space-y-3">
        <div className="rounded-lg border border-border p-3 space-y-1">
          <div className="font-medium">퇴직자 계정 처리</div>
          <p className="text-muted-foreground">담당자 퇴직 시 [기관 멤버] 탭에서 즉시 <strong>내보내기</strong>를 실행해 주세요. 처리하지 않으면 퇴직자가 계속 로그인할 수 있습니다.</p>
        </div>
        <div className="rounded-lg border border-border p-3 space-y-1">
          <div className="font-medium">AI 오류 발생 시</div>
          <p className="text-muted-foreground">AI 기능이 작동하지 않으면 잠시 후 다시 시도하세요. 반복될 경우 서비스 이용량 초과일 수 있습니다. 기관 내 담당자에게 일시적으로 AI 기능 사용을 자제하도록 안내해 주세요.</p>
        </div>
        <div className="rounded-lg border border-border p-3 space-y-1">
          <div className="font-medium">서비스 중단 시</div>
          <p className="text-muted-foreground">서비스 접속이 안 될 때는 기존 종이 상담기록지를 활용해 주세요. 복구 후 내용을 입력하시면 됩니다.</p>
        </div>
      </div>

      {/* FAQ */}
      <SectionTitle icon={HelpCircle}>자주 묻는 질문</SectionTitle>
      <div className="space-y-2">
        <FaqItem
          q="기관코드를 잃어버렸어요."
          a="[기관 멤버] 탭 상단 [기관코드 복사] 버튼을 누르면 언제든지 확인할 수 있습니다."
        />
        <FaqItem
          q="담당자를 관리자로 바꾸려면?"
          a="[기관 멤버] 탭에서 해당 담당자의 역할 드롭다운을 '관리자'로 변경하면 됩니다. 관리자는 복수 지정 가능합니다."
        />
        <FaqItem
          q="기관 데이터는 어디에 저장되나요?"
          a="모든 데이터는 Supabase(AWS 서울 리전) 클라우드 데이터베이스에 암호화 저장됩니다. Google Drive에 주 1회 자동 백업됩니다."
        />
      </div>

      <div className="mt-4">
        <NoteBox>
          관리자 전용 고급 설정은 <Badge variant="outline" className="text-xs mx-0.5">관리자 패널</Badge> 탭에서 확인할 수 있습니다.
        </NoteBox>
      </div>
    </div>
  );
}

export function UserGuideDialog({ open, onOpenChange, defaultTab = "user" }: UserGuideDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg w-full max-h-[85dvh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-5 pb-3 shrink-0 border-b border-border">
          <DialogTitle className="flex items-center gap-2 text-base">
            <BookOpen className="h-4 w-4 text-primary" />
            이용 가이드
          </DialogTitle>
        </DialogHeader>
        <Tabs defaultValue={defaultTab} className="flex flex-col flex-1 min-h-0">
          <TabsList className="grid grid-cols-2 mx-6 mt-3 shrink-0">
            <TabsTrigger value="user">이용자 가이드</TabsTrigger>
            <TabsTrigger value="admin">관리자 가이드</TabsTrigger>
          </TabsList>
          <TabsContent value="user" className="flex-1 overflow-y-auto px-6 py-4 mt-0">
            <UserGuideContent />
          </TabsContent>
          <TabsContent value="admin" className="flex-1 overflow-y-auto px-6 py-4 mt-0">
            <AdminGuideContent />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
