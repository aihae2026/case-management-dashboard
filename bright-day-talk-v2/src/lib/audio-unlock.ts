// 아이폰·아이패드 Safari는 소리 재생을 "사용자가 누른 순간"에 시작해야 허용한다.
// 읽어 주기는 소리를 만드는 동안 몇 초 기다린 뒤 재생하므로, 그대로 두면 재생이 막힐 수 있다.
// 누른 순간 아주 짧은 무음을 먼저 재생해 이 audio 요소의 재생 권한을 열어 두고,
// 소리가 준비되면 같은 요소의 주소만 바꿔 재생한다. 크롬·삼성 인터넷·PC에서는 아무 영향이 없다.

// 0.1초짜리 무음 WAV(8kHz, 16bit, 모노)를 data 주소로 만든다.
export function silentWavDataUri(): string {
  const sampleRate = 8000;
  const samples = 800;
  const dataSize = samples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true); // fmt 크기
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 모노
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // 초당 바이트
  v.setUint16(32, 2, true); // 샘플당 바이트
  v.setUint16(34, 16, true); // 비트 수
  text(36, "data");
  v.setUint32(40, dataSize, true);
  // 나머지는 0으로 채워진 채 그대로 둔다(무음)
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return "data:audio/wav;base64," + btoa(bin);
}

let cached: string | null = null;

// 사용자가 버튼을 누른 같은 순간에 호출한다 (await 뒤에서 부르면 소용없다).
export function unlockAudio(audio: HTMLAudioElement): void {
  try {
    if (cached === null) cached = silentWavDataUri();
    audio.src = cached;
    const p = audio.play();
    // 소리가 준비되어 주소를 바꾸면 이 재생은 중단된다. 그 오류는 정상이므로 무시한다.
    if (p) p.catch(() => {});
  } catch {
    /* 재생을 지원하지 않는 환경이면 건너뛴다 */
  }
}
