/**
 * SVG → PNG 아이콘 생성 스크립트 (일회성 실행)
 * bun run scripts/make-icons.mjs
 */
import { writeFileSync } from "fs";
import { Resvg } from "@resvg/resvg-js";

// 배경색 + 흰색 heart-handshake 아이콘 SVG
function makeSvg(size, bgColor = "#1877F2") {
  const r = Math.round(size * 0.225); // 둥근 모서리 비율
  const pad = Math.round(size * 0.17);
  const iconSize = size - pad * 2;
  const scale = iconSize / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${r}" fill="${bgColor}"/>
  <g transform="translate(${pad},${pad}) scale(${scale})" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>
    <path d="M12 5 9.04 7.96a2.17 2.17 0 0 0 0 3.08c.82.82 2.13.85 3 .07l2.07-1.9a2.82 2.82 0 0 1 3.79 0l2.96 2.66"/>
    <path d="M18 15l2-2"/>
    <path d="M15 18l2-2"/>
  </g>
</svg>`;
}

// SVG 파일도 저장 (fallback용)
writeFileSync("public/icon.svg", makeSvg(512));
writeFileSync("public/icon-192.svg", makeSvg(192));
writeFileSync("public/icon-512.svg", makeSvg(512));
writeFileSync("public/apple-touch-icon.svg", makeSvg(180));
// 관리자용 흑백 SVG
writeFileSync("public/icon-admin.svg", makeSvg(512, "#2c2c2c"));
writeFileSync("public/icon-192-admin.svg", makeSvg(192, "#2c2c2c"));
writeFileSync("public/icon-512-admin.svg", makeSvg(512, "#2c2c2c"));
writeFileSync("public/apple-touch-icon-admin.svg", makeSvg(180, "#2c2c2c"));
console.log("SVG 아이콘 생성 완료");

// @resvg/resvg-js로 PNG 변환
const sizes = [
  // 일반 (파란 배경)
  { file: "public/icon-192.png", size: 192, bg: "#1877F2" },
  { file: "public/icon-512.png", size: 512, bg: "#1877F2" },
  { file: "public/apple-touch-icon.png", size: 180, bg: "#1877F2" },
  // 관리자 (흑백)
  { file: "public/icon-192-admin.png", size: 192, bg: "#2c2c2c" },
  { file: "public/icon-512-admin.png", size: 512, bg: "#2c2c2c" },
  { file: "public/apple-touch-icon-admin.png", size: 180, bg: "#2c2c2c" },
];

for (const { file, size, bg } of sizes) {
  const svg = makeSvg(size, bg);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();
  writeFileSync(file, pngBuffer);
  console.log(`PNG 생성: ${file} (${size}x${size})`);
}

console.log("PNG 변환 완료!");
