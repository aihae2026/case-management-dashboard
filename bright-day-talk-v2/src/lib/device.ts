// 기기·브라우저 종류를 알아보는 함수. 브라우저에서만 부른다(effect나 클릭 처리 안에서).

// 아이폰·아이패드. iPadOS 13 이후의 아이패드는 맥으로 위장하므로 터치 지점 수로 가려낸다.
export function isIOS(
  ua: string = navigator.userAgent,
  platform: string = navigator.platform,
  touchPoints: number = navigator.maxTouchPoints,
): boolean {
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return platform === "MacIntel" && touchPoints > 1;
}

// 카카오톡·네이버 앱·라인·인스타그램·페이스북·다음·밴드 등 앱 안에서 연 브라우저.
// 이런 곳은 음성 입력과 홈 화면 추가가 막혀 있다.
export function isInAppBrowser(ua: string = navigator.userAgent): boolean {
  return /KAKAOTALK|NAVER\(inapp|Line\/|Instagram|FBAN|FBAV|DaumApps|BAND\//i.test(ua);
}

// 화면 꾸미기 도구(Tailwind 4)가 전제하는 기능(@property)을 지원하지 않는 오래된 브라우저.
// 아이폰은 iOS 16.4 미만, 안드로이드는 크롬 111 미만, 파이어폭스는 128 미만이 해당한다.
export function isOutdatedBrowser(): boolean {
  return typeof CSS === "undefined" || !("registerProperty" in CSS);
}
