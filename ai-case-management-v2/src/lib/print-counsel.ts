import { splitNote } from "./case-types";
import type { ActivityLog, Client } from "./case-types";

export type ApprovalRole = { role: string; active: boolean };

/** 결재라인 기본값 (전체 활성화) */
export const DEFAULT_APPROVAL_ROLES: ApprovalRole[] = [
  { role: "담당", active: true },
  { role: "팀장", active: true },
  { role: "과장", active: true },
  { role: "부장", active: true },
  { role: "관장", active: true },
];

function esc(s: string | null | undefined) {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>");
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("ko-KR", {
    year: "numeric", month: "2-digit", day: "2-digit",
  });
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("ko-KR", {
    hour: "2-digit", minute: "2-digit",
  });
}

export function printCounselRecord(
  log: ActivityLog,
  client: Client,
  approvalLine: ApprovalRole[],
) {
  const parsed = splitNote(client.note);
  const family = parsed.familyMembers;

  // 주민번호 조합 (앞자리 + 뒷자리 첫 1자리 + *****)
  const rrn = client.rrn_front
    ? `${client.rrn_front}-${client.rrn_back1 ?? ""}******`
    : "";

  // 가족관계 행 (최소 2행 보장)
  const minFamilyRows = Math.max(family.length, 2);
  const familyRows = Array.from({ length: minFamilyRows }, (_, i) => {
    const m = family[i];
    return `
      <tr>
        <td>${esc(m?.name)}</td>
        <td>${esc(m?.relation)}</td>
        <td>${esc(m?.birth)}</td>
        <td>${esc(m?.occupation)}</td>
        <td>${esc(m?.name)}</td>
        <td>${esc(m?.relation)}</td>
        <td>${esc(m?.birth)}</td>
        <td>${esc(m?.occupation)}</td>
      </tr>`;
  }).join("");

  // 결재라인: active인 항목만 표시
  const activeRoles = approvalLine.filter(r => r.active);
  const approvalHeader = activeRoles.map(r => `<th>${esc(r.role)}</th>`).join("");
  const approvalBoxes = activeRoles.map(() => `<td class="sign-cell"></td>`).join("");

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>상담기록서 - ${esc(client.name)}</title>
<style>
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: '맑은 고딕', 'Malgun Gothic', sans-serif; font-size: 9pt; color: #000; background: #fff; padding: 12mm; }
  h1 { font-size: 18pt; font-weight: bold; letter-spacing: 6px; text-align: center; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; }
  td, th { border: 1px solid #000; padding: 1.5mm 2mm; vertical-align: middle; font-size: 8.5pt; }
  th { background: #f0f0f0; font-weight: normal; white-space: nowrap; }
  .approval-table { width: auto; border-collapse: collapse; }
  .approval-table th { font-size: 7.5pt; text-align: center; padding: 1mm 2mm; min-width: 16mm; }
  .approval-table td { height: 12mm; min-width: 16mm; text-align: center; vertical-align: top; font-size: 7.5pt; padding: 1mm; }
  .section-label { background: #e8e8e8; font-weight: bold; font-size: 8.5pt; padding: 1.5mm 2mm; }
  .content-box { min-height: 40mm; height: 40mm; vertical-align: top; padding: 2mm; font-size: 8.5pt; line-height: 1.5; }
  .content-result { min-height: 32mm; height: 32mm; vertical-align: top; padding: 2mm; font-size: 8.5pt; line-height: 1.5; }
  .no-border { border: none !important; }
  .gap { margin-top: 1.5mm; }
  .family-th { white-space: nowrap; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <table style="width:100%;border:none;border-collapse:collapse;margin-bottom:3mm">
    <tr>
      <td style="border:none;width:${activeRoles.length * 17}mm"></td>
      <td style="border:none;text-align:center;vertical-align:middle">
        <h1>상 담 기 록 서</h1>
      </td>
      <td style="border:none;vertical-align:top;width:${activeRoles.length * 17}mm">
        ${activeRoles.length > 0 ? `<table class="approval-table" style="float:right"><tr>${approvalHeader}</tr><tr>${approvalBoxes}</tr></table>` : ""}
      </td>
    </tr>
  </table>

  <table>
    <tr>
      <th>성&nbsp;&nbsp;&nbsp;&nbsp;명</th>
      <td>${esc(client.name)}</td>
      <th>성별</th>
      <td>${esc(client.gender)}</td>
      <th>생년월일</th>
      <td>${esc(client.birth)}</td>
    </tr>
    <tr>
      <th>연&nbsp;&nbsp;락&nbsp;&nbsp;처</th>
      <td colspan="5">${esc(client.phone)}</td>
    </tr>
    <tr>
      <th>주&nbsp;&nbsp;&nbsp;&nbsp;소</th>
      <td colspan="5">${esc(client.address)}${client.address_detail ? " " + esc(client.address_detail) : ""}</td>
    </tr>
  </table>

  <!-- 가족관계 -->
  <table class="gap">
    <tr>
      <td rowspan="${minFamilyRows + 1}" class="section-label" style="width:24px;writing-mode:vertical-rl;text-align:center;letter-spacing:4px">가족관계</td>
      <th class="family-th">성명</th>
      <th class="family-th">관계</th>
      <th class="family-th">생년월일</th>
      <th class="family-th">직업</th>
      <th class="family-th">성명</th>
      <th class="family-th">관계</th>
      <th class="family-th">생년월일</th>
      <th class="family-th">직업</th>
    </tr>
    ${familyRows}
  </table>

  <!-- 상담 기본 정보 -->
  <table class="gap">
    <tr>
      <th>신&nbsp;&nbsp;청&nbsp;&nbsp;인</th>
      <td>${esc(client.name)}</td>
      <td class="no-border" style="width:10mm"></td>
      <th>상&nbsp;&nbsp;담&nbsp;&nbsp;일</th>
      <td>${esc(fmtDate(log.created_at))}</td>
    </tr>
    <tr>
      <th>상&nbsp;담&nbsp;자&nbsp;명</th>
      <td>${esc(log.worker_name)}</td>
      <td class="no-border"></td>
      <th>상담형태</th>
      <td>${esc(log.method)}</td>
    </tr>
    <tr>
      <th>상담제목</th>
      <td colspan="4">${esc(log.title)}</td>
    </tr>
  </table>

  <!-- 상담내용 -->
  <table class="gap">
    <tr>
      <td class="section-label">상담내용</td>
    </tr>
    <tr>
      <td class="content-box">${esc(log.note)}</td>
    </tr>
  </table>

  <!-- 상담결과 -->
  <table class="gap">
    <tr>
      <td class="section-label">상담결과</td>
    </tr>
    <tr>
      <td class="content-result">${esc(log.result)}</td>
    </tr>
  </table>

</body>
</html>`;

  const win = window.open("", "_blank", "width=794,height=1123");
  if (!win) { alert("팝업이 차단되었습니다. 팝업을 허용해주세요."); return; }
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); }, 400);
}
