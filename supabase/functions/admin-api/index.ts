// admin-api / index.ts
// 관리자 화면(admin.html)의 모든 데이터 접근을 대행한다: 비밀번호 검증 후 PostgREST를 service_role로 호출.
// 이 파일은 Supabase Edge Function 배포본의 사본이다 (2026-09-06, v14). 배포는 Supabase에서 하고,
// 여기 저장소 사본은 변경 이력·되돌리기용으로 유지한다. 원본(v13)과의 차이:
//   - data_history(변경 이력) 표를 허용 목록에 추가하되 GET(읽기)만 허용 — 이력은 관리자 화면에서
//     지우거나 고칠 수 없어야 하므로 POST/PATCH/DELETE는 403으로 막는다.
// v15 (2026-09-19): counsel_drafts(상담 준비 초안) 허용 목록 추가. ★ 이 사본만 고쳐도 반영되지 않는다 —
//     Supabase에 다시 배포해야 상담 준비 탭의 '저장'이 403 table_not_allowed를 면한다.
//     (2026-11-01: 이 사본이 v14에 멈춰 있어서, 배포본 v15를 그대로 옮겨 온 뒤 v16을 얹었다)
// v16 (2026-11-01, 아직 배포 전): 모의고사 학생별 분석지(PDF) 보관함 작업 추가 — body에 path 대신
//     storage: { op, ... } 를 보낸다. 보관함은 비공개 'mock-reports'(supabase/mock-reports.sql)이고,
//     파일 경로는 {mock_exams.id}/{students.id}.pdf 로만 허용한다. 파일 바이트는 이 함수를 거치지 않고
//     브라우저가 서명 업로드 주소로 직접 올린다 (함수 메모리·시간 제한을 피하려고).

const SUPABASE_URL = Deno.env.get("SB_URL")!;
const SERVICE_ROLE = Deno.env.get("SB_SERVICE_ROLE")!;
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD")!;

const ALLOWED_TABLES = new Set([
  "classes", "students", "weeks", "scores", "mock_exams", "mock_scores",
  "memos", "app_settings",
  "data_history",
  // 상담 준비 탭의 초안 보관 표. 조회·저장·수정은 전부 기존 api()로 하므로 이 한 줄만 있으면 된다.
  // (스키마: supabase/functions/counsel-draft/schema.sql)
  "counsel_drafts",
]);
// 읽기만 허용하는 표
const READ_ONLY_TABLES = new Set(["data_history"]);

// 모의고사 분석지 보관함 (v16)
const REPORT_BUCKET = "mock-reports";
const REPORT_PATH_RE = /^\d+\/\d+\.pdf$/;
const REPORT_PREVIEW_SEC = 300; // 관리자 미리보기 링크 유효 시간

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

function jres(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── 분석지 보관함 (v16) ──
const storageHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

async function storageFetch(sub: string, init: RequestInit): Promise<{ status: number; data: any }> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/${sub}`, init);
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (res.status >= 400) console.log("storage 실패 |", sub, "| 상태:", res.status, "| 응답:", text.slice(0, 300));
  return { status: res.status, data };
}

async function listExamReports(examId: number) {
  const r = await storageFetch(`object/list/${REPORT_BUCKET}`, {
    method: "POST", headers: storageHeaders,
    body: JSON.stringify({ prefix: String(examId), limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } }),
  });
  if (r.status >= 400 || !Array.isArray(r.data)) return r;
  const files = r.data
    .filter((o: any) => /^\d+\.pdf$/.test(o.name || ""))
    .map((o: any) => ({
      student_id: parseInt(o.name),
      updated_at: o.updated_at || o.created_at || null,
      size: o.metadata?.size ?? null,
    }));
  return { status: 200, data: files };
}

async function handleStorage(s: any): Promise<Response> {
  const op = s?.op;
  const badPath = (p: unknown) => typeof p !== "string" || !REPORT_PATH_RE.test(p);

  // 시험 여러 개의 업로드 현황 { "<examId>": [{student_id, updated_at, size}] }
  if (op === "list") {
    const ids = Array.isArray(s.exam_ids) ? s.exam_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [];
    if (!ids.length || ids.length > 50) return jres({ error: "bad_exam_ids" }, 400);
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const r = await listExamReports(id);
      if (r.status >= 400) return jres({ error: "storage_error", detail: r.data }, r.status);
      out[id] = r.data;
    }
    return jres({ files: out });
  }

  // 업로드용 서명 주소 (같은 경로가 있으면 덮어쓴다)
  if (op === "sign_upload") {
    if (badPath(s.path)) return jres({ error: "bad_path" }, 400);
    const r = await storageFetch(`object/upload/sign/${REPORT_BUCKET}/${s.path}`, {
      method: "POST", headers: { ...storageHeaders, "x-upsert": "true" },
    });
    if (r.status >= 400 || !r.data?.url) return jres({ error: "storage_error", detail: r.data }, r.status >= 400 ? r.status : 502);
    return jres({ url: `${SUPABASE_URL}/storage/v1${r.data.url}` });
  }

  // 미리보기용 읽기 주소 (5분)
  if (op === "sign") {
    if (badPath(s.path)) return jres({ error: "bad_path" }, 400);
    const r = await storageFetch(`object/sign/${REPORT_BUCKET}/${s.path}`, {
      method: "POST", headers: storageHeaders, body: JSON.stringify({ expiresIn: REPORT_PREVIEW_SEC }),
    });
    const signed = r.data?.signedURL || r.data?.signedUrl;
    if (r.status >= 400 || !signed) return jres({ error: "storage_error", detail: r.data }, r.status >= 400 ? r.status : 404);
    return jres({ url: `${SUPABASE_URL}/storage/v1${signed}` });
  }

  // 파일 삭제 (paths 지정) 또는 시험 하나의 분석지 전부 삭제 (exam_id)
  if (op === "remove") {
    let paths: string[] = [];
    if (s.exam_id !== undefined) {
      const id = Number(s.exam_id);
      if (!Number.isInteger(id) || id <= 0) return jres({ error: "bad_exam_id" }, 400);
      const r = await listExamReports(id);
      if (r.status >= 400) return jres({ error: "storage_error", detail: r.data }, r.status);
      paths = (r.data as any[]).map((f) => `${id}/${f.student_id}.pdf`);
    } else {
      if (!Array.isArray(s.paths) || !s.paths.length || s.paths.length > 500 || s.paths.some(badPath)) {
        return jres({ error: "bad_path" }, 400);
      }
      paths = s.paths;
    }
    if (!paths.length) return jres({ removed: 0 });
    const r = await storageFetch(`object/${REPORT_BUCKET}`, {
      method: "DELETE", headers: storageHeaders, body: JSON.stringify({ prefixes: paths }),
    });
    if (r.status >= 400) return jres({ error: "storage_error", detail: r.data }, r.status);
    return jres({ removed: Array.isArray(r.data) ? r.data.length : paths.length });
  }

  return jres({ error: "unknown_storage_op" }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  let payload: { password?: string; path?: string; method?: string; body?: unknown; prefer?: string; storage?: unknown; };
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

  // v16: 분석지 보관함 작업은 PostgREST 경로 검사와 별개로 처리한다
  if (payload.storage) {
    try {
      return await handleStorage(payload.storage);
    } catch (e) {
      console.log("storage upstream_error:", String(e));
      return jres({ error: "upstream_error", detail: String(e) }, 502);
    }
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
