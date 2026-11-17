// 복순이 아바타 → 파비콘 일괄 변환
// bun run scripts/gen-favicons.mjs

import sharp from "sharp";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SRC = join(import.meta.dir, "../src/assets/companion-avatar.png");
const OUT = join(import.meta.dir, "../public");

// 원형 마스크 SVG 생성 (edge: 이미지 크기)
const circleMask = (size) =>
  Buffer.from(
    `<svg><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" /></svg>`
  );

// 원형 마스크 적용 — 투명 배경, zoom으로 얼굴 꽉 채우기
// zoom > 1 이면 이미지를 확대 후 중앙 크롭 → 얼굴이 더 크게 보임
async function makeCircle(srcPath, size, padding = 0, zoom = 1.45) {
  const inner = size - padding * 2;
  const zoomed = Math.round(inner * zoom);

  // 1) 확대 리사이즈 후 중앙 크롭
  const cropped = await sharp(srcPath)
    .resize(zoomed, zoomed, { fit: "cover", position: "centre" })
    .extract({
      left: Math.round((zoomed - inner) / 2),
      top:  Math.round((zoomed - inner) / 2),
      width: inner,
      height: inner,
    })
    .toBuffer();

  // 2) 원형 마스크 적용
  const avatar = await sharp(cropped)
    .composite([{ input: circleMask(inner), blend: "dest-in" }])
    .png()
    .toBuffer();

  if (padding === 0) return avatar;

  // padding이 있으면 투명 캔버스 중앙에 배치
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: avatar, top: padding, left: padding }])
    .png()
    .toBuffer();
}

async function main() {
  console.log("🎨 파비콘 생성 중... (배경 투명)");

  // favicon-32x32.png — 원형 아바타, 투명 배경
  const fav32 = await makeCircle(SRC, 32);
  writeFileSync(join(OUT, "favicon-32x32.png"), fav32);
  console.log("✅ favicon-32x32.png");

  // apple-touch-icon.png — 180x180, 투명 배경
  const apple = await makeCircle(SRC, 180);
  writeFileSync(join(OUT, "apple-touch-icon.png"), apple);
  console.log("✅ apple-touch-icon.png");

  // pwa-192x192.png — 투명 배경
  const pwa192 = await makeCircle(SRC, 192);
  writeFileSync(join(OUT, "pwa-192x192.png"), pwa192);
  console.log("✅ pwa-192x192.png");

  // pwa-512x512.png — 투명 배경
  const pwa512 = await makeCircle(SRC, 512);
  writeFileSync(join(OUT, "pwa-512x512.png"), pwa512);
  console.log("✅ pwa-512x512.png");

  // pwa-512x512-maskable.png — 10% safe zone, 투명 배경
  const mask512 = await makeCircle(SRC, 512, Math.round(512 * 0.1));
  writeFileSync(join(OUT, "pwa-512x512-maskable.png"), mask512);
  console.log("✅ pwa-512x512-maskable.png");

  console.log("\n🎉 완료! public/ 폴더에 저장됨");
}

main().catch(console.error);
