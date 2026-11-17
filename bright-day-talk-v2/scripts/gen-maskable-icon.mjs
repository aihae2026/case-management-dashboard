// maskable 아이콘 생성 스크립트 (jimp 0.22.x API)
import Jimp from "jimp";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, "../public");

const SIZE = 512;
const ICON_SIZE = Math.round(SIZE * 0.75); // 384px
const PADDING = Math.round((SIZE - ICON_SIZE) / 2); // 64px

const src = path.join(PUBLIC, "pwa-512x512.png");
const dest = path.join(PUBLIC, "pwa-512x512-maskable.png");

// 배경 생성 (#FFF8F5)
const bg = await new Promise((resolve, reject) =>
  new Jimp(SIZE, SIZE, 0xFFF8F5FF, (err, img) => err ? reject(err) : resolve(img))
);

// 원본 읽기 → 축소
const icon = await Jimp.read(src);
icon.resize(ICON_SIZE, ICON_SIZE);

// 중앙 합성
bg.composite(icon, PADDING, PADDING);
await bg.writeAsync(dest);

console.log(`✅ 생성 완료: pwa-512x512-maskable.png`);
console.log(`   전체: ${SIZE}×${SIZE}px | 아이콘: ${ICON_SIZE}×${ICON_SIZE}px | 여백: ${PADDING}px`);
