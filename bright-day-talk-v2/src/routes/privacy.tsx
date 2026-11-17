import { createFileRoute, Link } from "@tanstack/react-router";
import { ORG_NAME } from "@/lib/org-config";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
});

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-[1.1rem] font-extrabold text-foreground border-l-4 border-primary pl-3">
        {title}
      </h2>
      <div className="space-y-2 text-base leading-relaxed text-muted-foreground">
        {children}
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <span className="w-32 shrink-0 font-semibold text-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

export default function PrivacyPage() {
  return (
    <div className="min-h-[100dvh] bg-background px-5 py-10">
      <div className="mx-auto w-full max-w-xl">

        {/* 헤더 */}
        <div className="mb-8">
          <Link
            to="/"
            className="mb-4 inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-sm font-semibold text-muted-foreground"
          >
            ← 홈으로
          </Link>
          <h1 className="text-2xl font-extrabold text-foreground">개인정보처리방침</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {ORG_NAME} · 복순이 말벗 서비스<br />
            시행일: 2026년 10월 7일
          </p>
        </div>

        <p className="mb-4 rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed text-foreground">
          이 처리방침은 <strong>예시</strong>입니다. 서비스를 도입하는 기관은 자기 기관의
          방침으로 바꾸고, 국외 이전(Google)과 음성 입력 내용을 반영한 뒤 법률 검토를 받아 사용해야 합니다.
        </p>

        <p className="mb-8 rounded-2xl bg-primary/8 px-4 py-3 text-base leading-relaxed text-foreground">
          {ORG_NAME}(이하 "복지관")은 어르신의 개인정보를 소중하게 여기며,
          「개인정보보호법」을 준수합니다. 이 방침은 복순이 말벗 서비스(이하 "서비스")를 통해
          처리하는 개인정보에 관한 사항을 안내합니다.
        </p>

        {/* 1. 수집 항목 */}
        <Section title="1. 처리하는 개인정보 항목">
          <div className="rounded-2xl bg-card p-4 shadow-sm space-y-2.5">
            <Row label="등록할 때" value="성명, 전화번호, 기관코드, 생년월일 6자리(본인 확인용)" />
            <Row
              label="사례관리에서 가져오는 정보"
              value="복지관 사례관리 시스템에 담당 복지사가 기록한 성별, 담당 복지사, 사례관리 구분, 위험도, 주요 욕구, 주거·복지 상태, 상담 기록 요약(건강·생활 상태 포함), 목표, 제공 서비스 내역"
            />
            <Row
              label="이용하면서 생기는 정보"
              value="기기 식별 정보(세션 ID), 대화 내용, 접속 일시, AI가 대화를 정리한 분석 결과(기분, 위험도, 건강·생활 관련 언급, 위기 신호 등)"
            />
            <Row label="등록 신청할 때 자동 기록" value="IP 주소, 기기 종류 정보" />
            <Row
              label="기기에만 저장"
              value="프로필 사진, 목소리·속도·음량·글자 크기 설정은 이 기기의 브라우저에만 저장되며 서버로 보내지 않습니다."
            />
          </div>
          <p className="mt-2 text-sm">
            위치와 음성은 아래 5번에서 설명하는 것처럼 사용을 허용하거나 마이크 버튼을 누를 때만 쓰입니다.
          </p>
        </Section>

        {/* 2. 이용 목적 */}
        <Section title="2. 개인정보 처리 근거와 이용 목적">
          <p>
            복지관은 어르신이 제출하신 「AI 기능 활용 동의서」에 따라 개인정보를 처리합니다
            (「개인정보보호법」 제15조제1항제1호). 동의서를 제출하신 분만 등록·승인되어
            서비스를 이용하실 수 있습니다.
          </p>
          <p className="font-semibold text-foreground">이용 목적</p>
          <ul className="list-inside list-disc space-y-1 pl-1">
            <li>말벗 AI 대화 서비스 제공</li>
            <li>본인 확인 및 기기 등록·승인</li>
            <li>사례관리 기록을 참고한 맞춤 대화</li>
            <li>담당 사회복지사의 안전 확인 및 사례관리 지원</li>
            <li>과도한 요청 차단 등 서비스 보호</li>
          </ul>
        </Section>

        {/* 3. 담당 복지사 확인 + AI 안내 */}
        <Section title="3. 담당 복지사의 확인과 AI 이용 안내">
          <ul className="list-inside list-disc space-y-1.5 pl-1">
            <li>
              복순이는 사람이 아니라 생성형 인공지능(Google Gemini)이 답하는 서비스입니다.
              답변은 의료·법률 판단을 대신하지 않습니다.
            </li>
            <li>
              AI 답변을 만드는 Google Gemini는 결제(유료) 등급으로 쓸 때만 전달된 대화 내용을
              AI 모델 학습에 사용하지 않습니다(무료 등급은 학습에 쓰일 수 있어, 도입 기관이 키 등급을 확인해야 합니다).
            </li>
            <li>
              어르신과 복순이의 대화 내용, 그리고 AI가 정리한 분석 결과는
              담당 사회복지사가 안전을 확인하기 위해 볼 수 있습니다.
            </li>
            <li>
              담당 사회복지사가 정한 주제(최대 3개)를 복순이가 대화 중에 자연스럽게 여쭤볼 수 있습니다.
            </li>
            <li>
              대화에는 건강에 관한 이야기가 포함될 수 있으며, 위 이용 목적 안에서만 사용합니다.
            </li>
          </ul>
        </Section>

        {/* 4. 제3자 제공 */}
        <Section title="4. 개인정보 제3자 제공">
          <p>
            복지관은 법령에 근거가 있는 경우를 제외하고 개인정보를 복지관 밖에 제공하지 않습니다.
            담당 사회복지사는 복지관 직원으로서 위 이용 목적 안에서 정보를 확인합니다.
          </p>
        </Section>

        {/* 5. 처리 위탁 및 국외 이전 */}
        <Section title="5. 개인정보 처리 위탁 및 국외 이전">
          <div className="rounded-2xl bg-card p-4 shadow-sm space-y-2.5">
            <Row label="Supabase (대한민국)" value="데이터베이스 저장 및 관리" />
            <Row label="Vercel (대한민국)" value="웹 호스팅, 서버 함수 실행(대화·AI 요청을 처리하는 동안 일시 처리)" />
            <Row
              label="Google (해외)"
              value="Gemini를 통한 AI 대화 생성과 음성 합성(TTS), Google Drive 정기 백업 저장"
            />
            <Row label="Upstash" value="이용 횟수 제한을 위한 세션 ID·IP 일시 처리" />
          </div>
          <p className="mt-2 text-sm">
            각 수탁사는 위탁받은 업무 범위 내에서만 개인정보를 처리합니다.
            Google에는 서비스를 이용하는 동안 대화 내용과 사례관리 기록 요약 등이
            인터넷망을 통해 전송되어 위 목적 범위에서 처리되며, 구글의 시설이 있는 국가의
            서버에서 처리될 수 있습니다.
            국외 이전을 원하지 않으시면 아래 보호책임자에게 문의해 주세요.
            다만 이 경우 서비스 이용이 어려울 수 있습니다.
          </p>

          <p className="mt-4 font-semibold text-foreground">위탁이 아닌 외부 연결</p>
          <ul className="list-inside list-disc space-y-1.5 pl-1">
            <li>
              날씨 안부: 위치 사용을 허용한 기기에서만 현재 위치(위도·경도)가 날씨 제공 서비스
              Open-Meteo로 바로 전송됩니다. 복순이 서버에는 저장하지 않습니다.
            </li>
            <li>
              음성 입력: 마이크 버튼을 누르면 이용 중인 브라우저(크롬 등)의 음성 인식 기능이 음성을
              처리하며, 복순이는 글자로 바뀐 문장만 받습니다. 다만 브라우저에 따라 음성이 브라우저
              제조사 서버(크롬은 Google 등)로 전송되어 처리될 수 있으며, 이는 복순이가 아니라 해당 제조사의
              처리방침을 따릅니다.
            </li>
          </ul>
        </Section>

        {/* 6. 보유 및 파기 */}
        <Section title="6. 개인정보 보유 기간 및 파기">
          <ul className="list-inside list-disc space-y-1.5 pl-1">
            <li>서비스를 이용하는 동안 보유합니다.</li>
            <li>
              삭제를 요청하시면 보호책임자가 확인한 뒤 지체 없이 데이터베이스에서 삭제합니다.
              등록 정보, 대화 내용, 사례관리에서 가져온 정보가 모두 대상입니다.
            </li>
            <li>
              관리자 화면에서 등록을 삭제하면 등록 신청 정보만 지워집니다.
              대화 내용과 사례관리에서 가져온 정보는 자동으로 지워지지 않으므로
              삭제를 따로 요청해 주셔야 합니다.
            </li>
            <li>
              서비스 데이터는 주 1회 Google Drive의 비공개 폴더에 백업합니다.
              삭제를 요청하시면 백업 파일에 포함된 정보도 함께 파기합니다.
            </li>
            <li>관계 법령에 따라 보존이 필요한 경우에는 해당 기간 동안 별도로 보관합니다.</li>
          </ul>
        </Section>

        {/* 7. 안전성 확보조치 */}
        <Section title="7. 개인정보의 안전성 확보조치">
          <ul className="list-inside list-disc space-y-1 pl-1">
            <li>서비스와 서버 사이의 통신을 HTTPS로 암호화합니다.</li>
            <li>데이터베이스 접근 키는 서버에서만 사용하고 이용자 화면에 노출하지 않습니다.</li>
            <li>관리자 화면은 허용된 관리자 계정(구글 로그인)만 사용할 수 있습니다.</li>
            <li>짧은 시간에 반복되는 요청을 제한합니다.</li>
            <li>백업 파일은 비공개로 보관합니다.</li>
          </ul>
        </Section>

        {/* 8. 정보주체 권리 */}
        <Section title="8. 정보주체의 권리">
          <p>이용자는 언제든지 다음 권리를 행사할 수 있습니다.</p>
          <ul className="list-inside list-disc space-y-1 pl-1">
            <li>개인정보 열람 요청</li>
            <li>개인정보 수정·삭제 요청</li>
            <li>개인정보 처리 정지 요청</li>
            <li>동의 철회 (철회하시면 서비스를 이용하실 수 없습니다)</li>
          </ul>
          <p className="mt-2">
            권리 행사는 아래 개인정보 보호책임자에게 전화로 말씀하시면 됩니다.
            열람 요청은 10일 이내에 처리하며, 가족 등 대리인을 통해서도 요청할 수 있습니다.
          </p>
        </Section>

        {/* 9. 보호책임자 */}
        <Section title="9. 개인정보 보호책임자">
          <div className="rounded-2xl bg-card p-4 shadow-sm space-y-2.5">
            <Row label="소속 기관" value={ORG_NAME} />
            <Row label="책임자" value="홍길동 팀장" />
            <Row label="연락처" value="070-1234-5678" />
          </div>
          <p className="mt-2">
            개인정보 관련 문의, 불만, 침해 신고 등은 위 연락처로 접수해 주세요.
          </p>
        </Section>

        {/* 10. 구제 방법 */}
        <Section title="10. 권리 침해를 당하셨을 때">
          <div className="rounded-2xl bg-card p-4 shadow-sm space-y-2.5">
            <Row label="개인정보 분쟁조정위원회" value="1833-6972" />
            <Row label="개인정보 침해신고센터" value="118" />
            <Row label="경찰청 사이버범죄 신고" value="182" />
          </div>
        </Section>

        {/* 11. 변경 */}
        <Section title="11. 개인정보처리방침 변경">
          <p>
            이 방침이 바뀌면 이 페이지와 서비스 화면을 통해 지체 없이 알려드립니다.
          </p>
          <div className="rounded-2xl bg-card p-4 shadow-sm space-y-2.5">
            <Row label="2026. 10. 7." value="처리 항목, 담당 복지사 확인, 위탁·국외 이전, 파기, 안전성 확보조치 등 현재 서비스 내용에 맞게 개정" />
            <Row label="2026. 9. 1." value="최초 시행" />
          </div>
        </Section>

        {/* 하단 */}
        <div className="mt-10 border-t border-border pt-6 text-center text-sm text-muted-foreground">
          {ORG_NAME} · 복순이 말벗 서비스<br />
          문의: 070-1234-5678
        </div>
      </div>
    </div>
  );
}
