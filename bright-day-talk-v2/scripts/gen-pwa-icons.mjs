/**
 * PWA 아이콘 생성 스크립트 (PNG 소스 기반)
 * bun run scripts/gen-pwa-icons.mjs
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Jimp from "jimp";

const __dir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dir, "..", "public");
const src = join(publicDir, "icon-source.png");

const sizes = [
  { name: "pwa-192x192.png",      size: 192 },
  { name: "pwa-512x512.png",      size: 512 },
  { name: "apple-touch-icon.png", size: 180 },
  { name: "favicon-32x32.png",    size: 32  },
];

const img = await Jimp.read(src);

for (const { name, size } of sizes) {
  await img.clone().resize(size, size).writeAsync(join(publicDir, name));
  console.log(`✓ ${name} (${size}×${size})`);
}

console.log("\n✅ 아이콘 생성 완료!");
