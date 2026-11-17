# 침해사고 대응 절차

이 솔루션을 운영하는 기관이 개인정보 유출이나 계정 침해가 의심될 때 **무엇을 먼저, 누가, 어떻게** 할지 정리한 문서입니다. 법적 판단(신고·통지 여부)은 기관의 개인정보 보호책임자와 법무 담당이 확인해야 합니다.

## 1. 역할과 연락 체계

이 표는 각 기관의 개인정보처리방침(9항 개인정보 보호책임자, 10항 권익침해 구제방법)에 맞춰 작성했습니다. **다른 기관이 이 문서를 쓸 때는 표의 내용을 자기 기관 정보로 교체하세요.**

| 역할 | 담당 | 연락처 | 하는 일 |
|---|---|---|---|
| 개인정보 보호책임자 | (기관명) AI 사업 담당 (개인정보 보호 업무와 고충 처리) | admin@example.com | 사고 판단·보고·통지 결정, 문의·피해 구제 응대 |
| IT·시스템 담당(관리자 계정 보유) | (기관명) AI 사업 담당 | admin@example.com | 계정 정지, 키 교체, 서비스 조치 |
| 서비스 관리자(기관 관리자) | 서비스에서 '관리자' 권한을 가진 직원 (관리자 화면의 기관 멤버에서 확인) | 기관 내부 연락 | 멤버 내보내기, 기록 확인 |

### 외부 연락처 (개인정보처리방침 10항 기준)

| 기관 | 연락처 | 이럴 때 |
|---|---|---|
| 개인정보침해 신고센터(KISA) | 118 (privacy.kisa.or.kr) | 개인정보 침해·유출 신고와 상담 |
| 개인정보분쟁조정위원회 | 1833-6972 (www.kopico.go.kr) | 피해 구제와 분쟁 조정 |
| 경찰청 사이버범죄 신고 | 182 (ecrm.police.go.kr) | 해킹·계정 탈취 등 범죄가 의심될 때 |

개인정보보호위원회에 신고해야 하는지는 6장에서 판단하고, 신고 방법은 118에서 안내받을 수 있습니다.

## 2. 이런 때 시작합니다

- 직원이 계정·기기 분실이나 비밀번호 유출을 알려 왔을 때
- 관리자 화면의 접속 이력·열람 기록에 낯선 접속(모르는 IP, 한밤중, 짧은 시간에 많은 열람)이 보일 때
- Supabase·Vercel·Google·GitHub에서 보안 알림이 왔을 때
- AI 사용량(Gemini)이나 Google Drive 접근이 평소보다 갑자기 늘었을 때
- 대상자 정보가 의도하지 않은 곳에 공개된 것을 발견했을 때

## 3. 첫 1시간: 상황별 즉시 조치

### A. 직원 계정이 의심될 때
1. **서비스에서 내보내기**: 관리자 화면의 기관 멤버에서 해당 계정을 내보내기 합니다. (데이터 접근이 즉시 막힙니다.)
2. **Google 계정 정지**: Google Workspace 관리 콘솔에서 해당 계정을 정지하고 세션을 종료합니다. (삭제하지 않습니다.)
3. **범위 확인**: 아래 5장의 조회로 그 계정이 언제, 어떤 대상자를 열람·변경했는지 확인합니다.

### B. 운영 계정(서비스 관리자·IT 담당자 계정)이 침해됐을 때
1. Google 계정을 **정지**합니다. **삭제하지 마세요.** 삭제하면 그 계정이 소유한 Drive 파일(백업·동의서 등)과 Apps Script가 사라질 수 있습니다. 필요하면 소유권을 먼저 다른 계정으로 옮깁니다.
2. 아래 **키·비밀값을 모두 재발급**합니다(4장).
3. Supabase, Vercel, GitHub 계정의 비밀번호와 2단계 인증을 점검합니다.

### C. API 키·비밀값이 노출됐을 때
1. 노출된 키를 해당 서비스에서 **즉시 폐기**하고 새 키를 만듭니다.
2. 새 값을 등록하고 관련 함수를 다시 배포합니다(4장).
3. 노출 기간 동안의 사용 기록(Gemini 사용량, Supabase 로그)을 확인합니다.

### D. 데이터가 외부로 유출됐거나 접근 통제가 뚫린 것으로 보일 때
1. 먼저 **서비스 접근을 줄입니다**: 의심 계정 내보내기, 승인 대기 계정 점검(5장).
2. 승인 게이트가 켜져 있는지 확인합니다(5장의 `guard.config`). 꺼져 있으면 `supabase/approval-gate`의 강제 단계가 적용된 상태인지 확인합니다.
3. 필요하면 서비스를 일시 중단합니다(아래 "서비스 중단하기").

### E. AI 기능에 문제가 있을 때(잘못된 결과가 반복되거나 AI로 정보가 새는 것이 의심될 때)
- **AI 기능만 끄기**: Supabase Edge Function 시크릿에서 `GEMINI_API_KEY`를 삭제합니다. AI 기능은 "키 설정 필요" 안내와 함께 멈추고, 상담 입력·저장·조회 같은 AI 외 기능은 정상으로 동작합니다.
- 복순이 연동이 의심되면 `companion_lookup_secrets` 테이블의 해시를 삭제해 복순이의 조회를 막습니다.
- AI에 거부한 대상자가 전송됐는지 의심되면 해당 대상자의 AI 동의·거부 설정과 열람 기록을 확인합니다.

### 서비스 중단하기 (최후 수단)
- 가장 빠른 방법: Vercel에서 해당 프로젝트의 배포를 중단하거나(도메인 연결 해제), 모든 멤버를 내보내기 합니다.
- 데이터베이스까지 막아야 하면 Supabase 프로젝트를 일시 정지합니다. 정지하면 모든 기능이 멈추므로 책임자 승인 후에 실행하세요.

## 4. 키·비밀값 재발급 목록

| 대상 | 어디서 | 바꾼 뒤 할 일 |
|---|---|---|
| Supabase 서비스 키(service_role) | Supabase 대시보드 → API 설정 | Vercel 환경변수 `SUPABASE_SERVICE_ROLE_KEY`, Apps Script 속성 `SUPABASE_SERVICE_ROLE_KEY` 교체 후 재배포 |
| Gemini API 키 | Google AI Studio | Supabase Edge 시크릿 `GEMINI_API_KEY` 교체 후 `gemini`, `transcribe-audio` 재배포 |
| Drive 연동 비밀값 | 직접 새로 생성 | Edge 시크릿 `DRIVE_SECRET`과 Apps Script 쪽 값을 **같은 값으로** 교체 |
| 복순이 연동 비밀값 | `supabase/ops/rotate_companion_secret.sql` 절차 | 옛 값과 새 값을 둘 다 받는 단계로 교체한 뒤 옛 값 폐기 |
| 슈퍼 관리자 이메일 설정 | Vercel 환경변수 `SUPER_ADMIN_EMAILS` | 침해된 이메일을 목록에서 제거 후 재배포 |
| GitHub·Vercel·Supabase 개인 접근 토큰 | 각 서비스의 토큰 설정 | 사용 중인 도구에서 새 토큰으로 교체 |

시크릿 값을 바꾸는 명령 예시입니다. 값은 채팅·문서·저장소에 적지 않습니다.

```bash
npx supabase secrets set GEMINI_API_KEY=<새 키> --project-ref <프로젝트 ID>
npx supabase functions deploy gemini --project-ref <프로젝트 ID>
npx supabase functions deploy transcribe-audio --project-ref <프로젝트 ID>
```

## 5. 무슨 일이 있었는지 확인하기 (증거 보존)

기록은 **지우거나 수정하지 말고** 먼저 내려받아 보관합니다. Supabase SQL Editor에서 조회합니다.

```sql
-- 최근 7일 열람 기록: 사용자별 건수
select user_name, count(*) as 건수, max(created_at) as 마지막
from public.view_log where created_at > now() - interval '7 days'
group by user_name order by 건수 desc;

-- 특정 직원의 열람 기록 (이름은 바꿔서 사용)
select created_at, action, client_code, detail, ip
from public.view_log where user_name = '직원이름' order by created_at desc limit 200;

-- 접속 이력(IP 포함)
select created_at, user_name, action, ip
from public.access_log where created_at > now() - interval '7 days'
order by created_at desc limit 200;

-- 데이터 변경 이력(대상자·상담·제공이력·목표)
select created_at, actor_name, table_name, op, row_id
from public.audit_log where created_at > now() - interval '7 days'
order by created_at desc limit 200;

-- 승인 대기·미승인 계정
select id, name, email, status from public.profiles where status <> 'approved';

-- 기관 관리자 목록
select p.name, p.email, r.role
from public.user_roles r join public.profiles p on p.id = r.user_id
order by r.role;

-- 승인 게이트 상태
select * from guard.config;
```

관리자 화면(접속 이력·열람 기록·변경 히스토리)에서도 기간·직원별로 볼 수 있습니다. 잘못된 변경은 변경 히스토리의 되돌리기로 복구할 수 있습니다. Supabase·Vercel의 로그는 보관 기간이 짧으므로 **사고가 의심되면 바로 내려받아 두세요.**

## 6. 신고·통지 판단

- **기한 기준**: 개인정보가 유출된 사실을 안 때부터 **지체 없이, 72시간 이내를 기준**으로 정보주체에게 알리고, 규모와 유형에 따라 개인정보보호위원회 또는 한국인터넷진흥원(KISA)에 신고할지 판단합니다.
- 이 서비스의 정보에는 **건강·복지 관련 내용(민감정보에 해당할 수 있음)** 이 포함되므로 유출 규모가 작아도 신고 대상인지 반드시 확인하세요.
- 통지할 내용: 유출된 항목, 유출 시점과 경위, 정보주체가 할 수 있는 조치, 기관의 대응과 연락처
- 최신 기준은 개인정보보호위원회 안내와 118 상담센터에서 확인하세요. 최종 판단은 기관 책임자가 합니다.

## 7. 복구와 재발 방지

1. **복구**: 데이터가 손상·삭제됐다면 Google Drive의 정기 백업에서 복원합니다. `scripts/restore-from-backup.ts`는 기본이 비교만 하는 모드이고, `--apply`와 대상 호스트 확인을 모두 줘야 실제로 씁니다. 운영 프로젝트에 쓰기 전에 연습용 프로젝트에서 먼저 시험하세요.
2. **원인 분석**: 어떤 경로로 일어났는지(계정, 키, 설정 실수, 코드 결함) 정리합니다.
3. **재발 방지**: 키 교체, 권한 조정, 코드 수정, 안내 교육. 처리방침이나 동의서 변경이 필요하면 함께 고칩니다.
4. **기록**: 일시, 경위, 영향받은 대상자 수, 조치, 통지·신고 내역을 사고 기록으로 남깁니다.

## 8. 평소 점검 (분기 1회 권장)

- 접속 이력·열람 기록에 낯선 접속이 없는지
- 퇴사·담당 변경 직원의 계정을 내보내기 했는지, 승인 대기 계정이 방치되지 않았는지
- Google Drive 백업이 정상 생성되는지(폴더 이름 끝에 `_INCOMPLETE`가 없는지), 복원 연습을 해 보았는지
- 운영 계정 전체에 2단계 인증이 켜져 있는지
- Gemini 사용량과 비용이 평소 수준인지
- 키·비밀값을 마지막으로 바꾼 시점(연 1회 이상 교체 권장)
