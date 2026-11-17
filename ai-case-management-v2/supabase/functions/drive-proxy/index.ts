import { createClient } from "jsr:@supabase/supabase-js@2";

/** 호출한 사용자가 조회 전용(뷰어)인지 확인한다. 확인 실패 시 false(기존 동작 유지). */
async function isViewerCaller(authHeader: string | null): Promise<boolean> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !anon || !authHeader) return false;
    const c = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data, error } = await c.rpc("is_viewer");
    return !error && data === true;
  } catch {
    return false;
  }
}

/** 호출한 사용자가 기관에 소속되고 가입 승인이 끝났는지 확인한다. 확인 실패 시 false(막음). */
async function isApprovedCaller(authHeader: string | null, userId: string): Promise<boolean> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !anon || !authHeader) return false;
    const c = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: profile, error } = await c
      .from("profiles")
      .select("org_id,status")
      .eq("id", userId)
      .maybeSingle();
    return !error && !!profile?.org_id && profile.status === "approved";
  } catch {
    return false;
  }
}

const ALLOWED_ORIGINS = [
  ...(Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  "http://localhost:8080",
];

function makeCors(req: Request) {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const cors = makeCors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const DRIVE_URL = Deno.env.get("DRIVE_UPLOAD_URL");
    const DRIVE_SECRET = Deno.env.get("DRIVE_SECRET");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY");

    if (!DRIVE_URL || !DRIVE_SECRET) throw new Error("DRIVE_UPLOAD_URL 또는 DRIVE_SECRET 미설정");

    // JWT 검증은 anon key로 충분 (최소 권한 원칙)
    const authHeader = req.headers.get("Authorization");
    const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON!);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      authHeader?.replace("Bearer ", "") ?? ""
    );
    if (authErr || !user) throw new Error("인증 실패");

    // 가입 승인 전 계정·기관 미소속 계정은 어떤 요청(파일 읽기·업로드·OCR 포함)도 쓸 수 없다
    if (!(await isApprovedCaller(authHeader, user.id))) throw new Error("승인된 기관 멤버만 사용할 수 있습니다.");

    // 요청 본문 먼저 파싱
    const raw = await req.json();

    // 파일 내려받기는 아래 viewConsent 로만 허용한다 (클라이언트가 파일 ID를 직접 지정해 읽는 것을 막는다)
    if (raw.action === "getFileBase64") throw new Error("허용되지 않는 요청입니다.");

    // 동의서 열람: 직원의 로그인 권한(RLS)으로 그 대상자 행을 읽을 수 있을 때만 파일을 내려준다.
    // 파일 ID는 클라이언트가 보내지 않고, 서버가 DB의 consent_drive_id 를 읽어서 쓴다.
    // (가입 승인 전 계정·다른 기관 계정은 대상자 행을 읽을 수 없으므로 열람할 수 없다)
    if (raw.action === "viewConsent") {
      const clientId = typeof raw.clientId === "string" ? raw.clientId : "";
      if (!/^[0-9a-fA-F-]{36}$/.test(clientId)) throw new Error("잘못된 요청입니다.");

      const userClient = createClient(SUPABASE_URL!, SUPABASE_ANON!, {
        global: { headers: { Authorization: authHeader ?? "" } },
      });
      const { data: row, error: rowErr } = await userClient
        .from("clients")
        .select("consent_drive_id, org_id")
        .eq("id", clientId)
        .maybeSingle();
      if (rowErr || !row) throw new Error("대상자를 찾을 수 없거나 열람 권한이 없습니다.");
      if (!row.consent_drive_id) throw new Error("연결된 동의서가 없습니다.");

      let orgName: string | undefined;
      const SERVICE_KEY_V = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SERVICE_KEY_V) {
        const adminV = createClient(SUPABASE_URL!, SERVICE_KEY_V);
        const { data: orgV } = await adminV.from("organizations").select("name").eq("id", row.org_id).maybeSingle();
        orgName = orgV?.name ?? undefined;
      }
      const viewRes = await fetch(DRIVE_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({
          action: "getFileBase64",
          fileId: row.consent_drive_id,
          orgName,
          secret: DRIVE_SECRET,
        }),
      });
      const viewData = JSON.parse(await viewRes.text());
      if (viewData?.error) throw new Error(String(viewData.error));
      return new Response(JSON.stringify(viewData), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // 조회 전용(뷰어) 계정은 파일 업로드·OCR 등을 쓸 수 없다 (읽기: getFileText, viewConsent 만 허용)
    if (raw.action !== "getFileText" && (await isViewerCaller(authHeader))) {
      throw new Error("조회 전용 계정은 파일을 올릴 수 없어요.");
    }

    // 허용된 키만 GAS에 전달 (임의 키 주입 방지)
    const allowed: Record<string, unknown> = {};
    for (const key of ["action", "fileId", "name", "mimeType", "data", "folderName"] as const) {
      if (raw[key] !== undefined) allowed[key] = raw[key];
    }

    // 사용자의 기관 이름은 클라이언트가 보낸 값이 아니라 서버가 직접 조회해 붙인다 (서비스 롤로 — Supabase 자동 주입 시크릿)
    {
      const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SERVICE_KEY) {
        const admin = createClient(SUPABASE_URL!, SERVICE_KEY);
        const { data: prof } = await admin
          .from("profiles")
          .select("org_id")
          .eq("id", user.id)
          .maybeSingle();
        if (prof?.org_id) {
          const { data: org } = await admin
            .from("organizations")
            .select("name")
            .eq("id", prof.org_id)
            .maybeSingle();
          if (org?.name) allowed["orgName"] = org.name;
        }
      }
    }

    // 파일 내용을 읽는 요청(getFileText·extractOcrText)은 파일 ID만으로 다른 기관의 파일을 읽지 못하게 막는다.
    // Apps Script가 그 파일이 호출자 기관의 폴더 안에 있는지 확인하므로, 기관을 모르면 요청하지 않는다.
    if (raw.action === "getFileText" || raw.action === "extractOcrText") {
      if (typeof raw.fileId !== "string" || !/^[A-Za-z0-9_-]{10,100}$/.test(raw.fileId)) {
        throw new Error("잘못된 요청입니다.");
      }
      if (!allowed["orgName"]) throw new Error("기관 정보를 확인할 수 없어 파일을 읽을 수 없습니다.");
    }
    const driveRes = await fetch(DRIVE_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ ...allowed, secret: DRIVE_SECRET }),
    });
    const rawText = await driveRes.text();
    const driveData = JSON.parse(rawText);

    return new Response(JSON.stringify(driveData), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
