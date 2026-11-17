// favicon.svg에 아바타 PNG를 base64로 임베드
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const fav32 = readFileSync(join(import.meta.dir, "../public/favicon-32x32.png"));
const b64 = fav32.toString("base64");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 32 32">
  <image width="32" height="32" xlink:href="data:image/png;base64,${b64}"/>
</svg>`;

writeFileSync(join(import.meta.dir, "../public/favicon.svg"), svg);
console.log("✅ favicon.svg 업데이트 완료");
