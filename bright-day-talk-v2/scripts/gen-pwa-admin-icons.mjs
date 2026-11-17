/**
 * 관리자 PWA 아이콘 생성 (흑백)
 * bun run scripts/gen-pwa-admin-icons.mjs
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Jimp from "jimp";

const __dir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dir, "..", "public");
const src = join(publicDir, "icon-source.png");

const sizes = [
  { name: "pwa-admin-192x192.png",      size: 192 },
  { name: "pwa-admin-512x512.png",      size: 512 },
  { name: "apple-touch-icon-admin.png", size: 180 },
];

const img = await Jimp.read(src);

for (const { name, size } of sizes) {
  await img.clone()
    .resize(size, size)
    .grayscale()          // 흑백 변환
    .writeAsync(join(publicDir, name));
  console.log(`✓ ${name} (${size}×${size})`);
}

console.log("\n✅ 관리자 아이콘 생성 완료!");
