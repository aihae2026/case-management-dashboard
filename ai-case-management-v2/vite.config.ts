import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

const isVercel = process.env.VERCEL === "1";

export default defineConfig({
  plugins: [
    tanstackStart({
      server: {
        entry: "server",
        // @ts-expect-error TanStack Start 플러그인 타입 정의에 preset 누락 (기능은 정상)
        preset: isVercel ? "vercel" : "node",
      },
    }),
    react(),
    tailwindcss(),
    tsconfigPaths(),
  ],
  server: {
    port: 8080,
  },
});
