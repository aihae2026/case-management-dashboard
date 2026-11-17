import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import tsConfigPaths from "vite-tsconfig-paths";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    tanstackStart({
      server: {
        entry: "server",
      },
    }),
    react(),
    tailwindcss(),
    tsConfigPaths(),
    VitePWA({
      registerType: "autoUpdate",
      // public/manifest.json 이미 존재하므로 플러그인 자동 생성 비활성
      manifest: false,
      workbox: {
        // JS·CSS·HTML·아이콘·폰트 사전 캐시
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest,woff,woff2}"],
        // SSR 앱 — 서버가 라우팅을 처리하므로 navigateFallback 사용 안 함
        navigateFallback: null,
        // /api/* 는 SW가 절대 가로채지 않음 (채팅·TTS·인증 보호)
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "gfonts-cache",
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
      // 개발 서버에서는 SW 비활성 (HMR 간섭 방지)
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 3000,
    host: true,
    strictPort: true,
  },
});
