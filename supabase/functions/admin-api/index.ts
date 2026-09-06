// admin-api / index.ts
// 관리자 화면(admin.html)의 모든 데이터 접근을 대행한다: 비밀번호 검증 후 PostgREST를 service_role로 호출.
// 이 파일은 Supabase Edge Function 배포본의 사본이다 (2026-09-06, v14). 배포는 Supabase에서 하고,
// 여기 저장소 사본은 변경 이력·되돌리기용으로 유지한다. 원본(v13)과의 차이:
//   - data_history(변경 이력) 표를 허용 목록에 추가하되 GET(읽기)만 허용 — 이력은 관리자 화면에서
//     지우거나 고칠 수 없어야 하므로 POST/PATCH/DELETE는 403으로 막는다.

const SUPABASE_URL = Deno.env.get("SB_URL")!;
const SERVICE_ROLE = Deno.env.get("SB_SERVICE_ROLE")!;
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD")!;

const ALLOWED_TABLES = new Set([
  "classes", "students", "weeks", "scores", "mock_exams", "mock_scores",
  "memos", "app_settings",
  "data_history",
]);
// 읽기만 허용하는 표
const READ_ONLY_TABLES = new Set(["data_history"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

function tableOf(path: string): string {
  const q = path.indexOf("?");
  const head = q < 0 ? path : path.slice(0, q);
  return head.split("/")[0].trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  let payload: { password?: string; path?: string; method?: string; body?: unknown; prefer?: string; };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const { password, path, method = "GET", body = null, prefer } = payload;

  if (!password || !safeEqual(password, ADMIN_PASSWORD)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  if (!path || typeof path !== "string") {
    return new Response(JSON.stringify({ error: "missing_path" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const table = tableOf(path);
  if (!ALLOWED_TABLES.has(table)) {
    return new Response(JSON.stringify({ error: "table_not_allowed", table }), {
      status: 403, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const m = method.toUpperCase();
  if (!["GET", "POST", "PATCH", "DELETE"].includes(m)) {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (READ_ONLY_TABLES.has(table) && m !== "GET") {
    return new Response(JSON.stringify({ error: "read_only_table", table }), {
      status: 403, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const headers: Record<string, string> = {
    apikey: SERVICE_ROLE,
    Authorization: `Bearer ${SERVICE_ROLE}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers["Prefer"] = prefer;
  else if (m === "POST") headers["Prefer"] = "return=representation";

  const opts: RequestInit = { method: m, headers };
  if (body !== null && body !== undefined) opts.body = JSON.stringify(body);

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
    const text = await res.text();

    if (res.status >= 400) {
      console.log("실패 | method:", m, "| path:", path, "| 상태:", res.status, "| 응답:", text.slice(0, 400));
    }

    // 204(No Content)나 빈 본문은 본문 없이 그대로 반환해야 한다.
    // (본문 없는 상태코드에 body를 붙이면 TypeError 발생)
    if (res.status === 204 || res.status === 205 || !text) {
      return new Response(null, { status: res.status, headers: CORS });
    }

    return new Response(text, {
      status: res.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.log("upstream_error:", String(e));
    return new Response(JSON.stringify({ error: "upstream_error", detail: String(e) }), {
      status: 502, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
