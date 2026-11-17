// 이 서비스를 운영하는 기관의 이름. 배포 시 환경변수 VITE_ORG_NAME 으로 지정합니다.
// 개인정보 처리방침, 기관 선택 목록, 보호 기관 표시 등에 쓰입니다.
export const ORG_NAME: string =
  ((import.meta.env.VITE_ORG_NAME as string | undefined) ?? "").trim() || "(기관명)";
