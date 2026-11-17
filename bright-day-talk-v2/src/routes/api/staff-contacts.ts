import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/staff-contacts")({
  server: {
    handlers: {
      GET: () => {
        const e = (key: string) => process.env[`VITE_${key}`]?.trim() || process.env[key]?.trim() || "";
        // 표시 순서: lee(팀장) 먼저, baek 다음
        return Response.json([
          { name: e("STAFF_LEE_NAME")  || "담당 사회복지사", title: e("STAFF_LEE_TITLE")  || "팀장",       phone: e("STAFF_LEE_PHONE")  },
          { name: e("STAFF_BAEK_NAME") || "담당 사회복지사", title: e("STAFF_BAEK_TITLE") || "사회복지사", phone: e("STAFF_BAEK_PHONE") },
        ]);
      },
    },
  },
});
