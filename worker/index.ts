import type { Day, Snapshot, Timer, TimerState } from "../shared/types.ts";
import {
  YptError,
  dayFrom,
  groups,
  history,
  login,
  members,
  object,
  reload,
  remoteFrom,
  start,
  stop,
  subjectsFrom,
} from "./ypt.ts";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  YPT_ENCRYPTION_KEY: string;
  APP_ORIGIN: string;
}
type Session = {
  token_hash: string;
  account_id: string;
  csrf: string;
  expires_at: number;
};
type TimerRow = {
  state: TimerState;
  subject: string | null;
  started_at: number | null;
  origin: "web" | "app" | null;
  revision: number;
  pending_id: string | null;
  updated_at: number;
};
const encoder = new TextEncoder();
const TTL = 30 * 24 * 60 * 60 * 1000;
const COOKIE = "ypt_session";
const HISTORY_VALIDATED = true;
function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}
function fail(code: string, status: number, message: string) {
  return json({ code, error: message }, status);
}
function bytes64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
function b64bytes(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
function hex(bytes: Uint8Array) {
  return [...bytes].map((c) => c.toString(16).padStart(2, "0")).join("");
}
async function sha(value: string) {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}
async function master(env: Env) {
  let raw: Uint8Array;
  try {
    raw = b64bytes(env.YPT_ENCRYPTION_KEY);
  } catch {
    throw new Error("INVALID_KEY");
  }
  if (raw.byteLength !== 32) throw new Error("INVALID_KEY");
  return new Uint8Array(raw);
}
async function accountId(env: Env, email: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    (await master(env)) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(email.trim().toLowerCase()),
      ),
    ),
  );
}
async function aesKey(env: Env) {
  return crypto.subtle.importKey(
    "raw",
    (await master(env)) as BufferSource,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
async function encrypt(env: Env, account: string, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: encoder.encode(account),
    },
    await aesKey(env),
    encoder.encode(value),
  );
  return `v1:${bytes64(iv)}:${bytes64(new Uint8Array(sealed))}`;
}
async function decrypt(env: Env, account: string, value: string) {
  const [version, iv, body] = value.split(":");
  if (version !== "v1" || !iv || !body) throw new Error("INVALID_TOKEN");
  const decoded = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: b64bytes(iv) as BufferSource,
      additionalData: encoder.encode(account),
    },
    await aesKey(env),
    b64bytes(body) as BufferSource,
  );
  return new TextDecoder().decode(decoded);
}
function cookie(request: Request) {
  return (
    request.headers
      .get("Cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1) ?? null
  );
}
async function session(request: Request, env: Env) {
  const value = cookie(request);
  if (!value || !/^[0-9a-f]{64}$/.test(value)) return null;
  return env.DB.prepare(
    "SELECT token_hash, account_id, csrf, expires_at FROM sessions WHERE token_hash=? AND expires_at>?",
  )
    .bind(await sha(value), Date.now())
    .first<Session>();
}
async function credential(env: Env, account: string) {
  const row = await env.DB.prepare(
    "SELECT encrypted_jwt FROM accounts WHERE id=?",
  )
    .bind(account)
    .first<{ encrypted_jwt: string }>();
  if (!row) throw new Error("MISSING_ACCOUNT");
  return decrypt(env, account, row.encrypted_jwt);
}
async function timer(env: Env, account: string) {
  const row = await env.DB.prepare(
    "SELECT state, subject, started_at, origin, revision, pending_id, updated_at FROM timers WHERE account_id=?",
  )
    .bind(account)
    .first<TimerRow>();
  if (!row) throw new Error("MISSING_TIMER");
  return row;
}
function publicTimer(row: TimerRow): Timer {
  return {
    state: row.state,
    subject: row.subject,
    startedAt: row.started_at,
    revision: row.revision,
    updatedAt: row.updated_at,
    origin: row.origin,
  };
}
export async function reconcile(
  env: Env,
  account: string,
  remote: ReturnType<typeof remoteFrom>,
) {
  const current = await timer(env, account);
  if (
    remote.status === "unverified" ||
    ["starting", "stopping", "uncertain"].includes(current.state)
  )
    return current;
  if (
    remote.status === "running" &&
    remote.startedAt !== null &&
    remote.subject
  ) {
    if (current.state === "idle" || current.state === "paused") {
      await env.DB.prepare(
        "UPDATE timers SET state='running',subject=?,started_at=?,origin='app',revision=revision+1,updated_at=? WHERE account_id=? AND revision=? AND state=?",
      )
        .bind(
          remote.subject,
          remote.startedAt,
          Date.now(),
          account,
          current.revision,
          current.state,
        )
        .run();
    } else if (
      current.state === "running" &&
      (current.subject !== remote.subject ||
        Math.abs((current.started_at ?? 0) - remote.startedAt) >
          (current.origin === "app" ? 0 : 3000))
    ) {
      await env.DB.prepare(
        "UPDATE timers SET state='uncertain',revision=revision+1,updated_at=? WHERE account_id=? AND revision=? AND state='running'",
      )
        .bind(Date.now(), account, current.revision)
        .run();
    }
  } else if (remote.status === "idle" && current.state === "running") {
    await env.DB.prepare(
      "UPDATE timers SET state='idle',subject=NULL,started_at=NULL,origin=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND revision=? AND state='running'",
    )
      .bind(Date.now(), account, current.revision)
      .run();
  }
  return timer(env, account);
}
async function body(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("Content-Length")) > 4096) return null;
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return null;
  }
  if (raw.length > 4096) return null;
  try {
    return object(JSON.parse(raw));
  } catch {
    return null;
  }
}
function mutationAllowed(request: Request, env: Env, s?: Session | null) {
  const origin = request.headers.get("Origin");
  return (
    !!origin &&
    origin === env.APP_ORIGIN &&
    request.headers.get("Sec-Fetch-Site") !== "cross-site" &&
    (!s || request.headers.get("X-CSRF-Token") === s.csrf)
  );
}
async function limit(env: Env, email: string, request: Request) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const emailKey = await accountId(env, email);
  const ipKey = await accountId(env, `ip:${ip}`);
  const expiry = Date.now() + 15 * 60_000;
  for (const key of [`email:${emailKey}`, `ip:${ipKey}`]) {
    await env.DB.prepare(
      "INSERT INTO login_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<? THEN 1 ELSE count+1 END, expires_at=CASE WHEN expires_at<? THEN excluded.expires_at ELSE expires_at END",
    )
      .bind(key, expiry, Date.now(), Date.now())
      .run();
    const row = await env.DB.prepare(
      "SELECT count FROM login_limits WHERE key=?",
    )
      .bind(key)
      .first<{ count: number }>();
    if (!row || row.count > 10) return false;
  }
  return true;
}
function resultError(error: unknown) {
  if (error instanceof YptError) {
    if (error.code === "AUTH_EXPIRED")
      return fail(
        "AUTH_EXPIRED",
        401,
        "열품타 로그인이 만료됐습니다. 다시 로그인해 주세요.",
      );
    if (error.code === "REJECTED")
      return fail(
        "API_REJECTED",
        502,
        "열품타가 요청을 거절했습니다. 앱에서 상태를 확인해 주세요.",
      );
    return fail(
      "UPSTREAM_UNVERIFIED",
      503,
      "열품타 응답을 확인할 수 없습니다. 잠시 뒤 상태를 확인해 주세요.",
    );
  }
  return fail("SERVER_ERROR", 500, "요청을 처리하지 못했습니다.");
}
async function loginRoute(request: Request, env: Env) {
  if (!mutationAllowed(request, env))
    return fail("ORIGIN", 403, "요청 출처를 확인할 수 없습니다.");
  const input = await body(request);
  const email = typeof input?.email === "string" ? input.email.trim() : "";
  const password = typeof input?.password === "string" ? input.password : "";
  if (!email || email.length > 254 || !password || password.length > 256)
    return fail("INPUT", 400, "이메일과 비밀번호를 확인해 주세요.");
  if (!(await limit(env, email, request)))
    return fail(
      "RATE_LIMIT",
      429,
      "로그인 시도가 많습니다. 15분 뒤 다시 시도해 주세요.",
    );
  let jwt: string;
  try {
    jwt = await login(email, password);
    await reload(jwt);
  } catch (e) {
    return e instanceof YptError && e.code === "REJECTED"
      ? fail("LOGIN_FAILED", 401, "열품타 계정 정보를 확인해 주세요.")
      : resultError(e);
  }
  const id = await accountId(env, email);
  const sealed = await encrypt(env, id, jwt);
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const csrf = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts(id,encrypted_jwt,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET encrypted_jwt=excluded.encrypted_jwt",
    ).bind(id, sealed, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO timers(account_id,state,updated_at) VALUES(?,'idle',?)",
    ).bind(id, now),
    env.DB.prepare(
      "INSERT INTO sessions(token_hash,account_id,csrf,expires_at) VALUES(?,?,?,?)",
    ).bind(await sha(token), id, csrf, now + TTL),
  ]);
  const headers = {
    "Set-Cookie": `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${TTL / 1000}`,
  };
  return json({ authenticated: true, csrf }, 200, headers);
}
async function changeTimer(
  action: "start" | "pause" | "resume" | "stop" | "resolve",
  request: Request,
  env: Env,
  s: Session,
) {
  const input = await body(request);
  if (!input) return fail("INPUT", 400, "요청을 확인해 주세요.");
  const row = await timer(env, s.account_id);
  if (action === "resolve") {
    if (
      row.state !== "uncertain" &&
      row.state !== "starting" &&
      row.state !== "stopping"
    )
      return fail("STATE", 409, "복구할 상태가 없습니다.");
    if (input.confirmedStopped !== true)
      return fail("CONFIRM", 400, "앱에서 정지한 뒤 확인해 주세요.");
    const updated = await env.DB.prepare(
      "UPDATE timers SET state='idle',subject=NULL,started_at=NULL,origin=NULL,pending_id=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND revision=? AND state IN ('uncertain','starting','stopping')",
    )
      .bind(Date.now(), s.account_id, row.revision)
      .run();
    return updated.meta.changes
      ? json({ timer: publicTimer(await timer(env, s.account_id)) })
      : fail("CONFLICT", 409, "다른 탭에서 상태가 변경됐습니다.");
  }
  const op = input.operationId;
  if (
    typeof op !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(op) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision !== row.revision
  )
    return fail(
      "CONFLICT",
      409,
      "상태가 변경됐습니다. 새로고침 후 다시 확인해 주세요.",
    );
  const seen = await env.DB.prepare(
    "SELECT id FROM operations WHERE account_id=? AND id=?",
  )
    .bind(s.account_id, op)
    .first();
  if (seen)
    return fail(
      "DUPLICATE",
      409,
      "이미 처리한 요청입니다. 상태를 다시 확인해 주세요.",
    );
  if (
    (action === "start" && row.state !== "idle") ||
    (action === "resume" && row.state !== "paused") ||
    (["pause", "stop"].includes(action) && row.state !== "running")
  ) {
    if (action === "stop" && row.state === "paused") {
      const done = await env.DB.prepare(
        "UPDATE timers SET state='idle',subject=NULL,started_at=NULL,origin=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND revision=? AND state='paused'",
      )
        .bind(Date.now(), s.account_id, row.revision)
        .run();
      return done.meta.changes
        ? json({ timer: publicTimer(await timer(env, s.account_id)) })
        : fail("CONFLICT", 409, "상태가 변경됐습니다.");
    }
    return fail("STATE", 409, "현재 상태에서는 실행할 수 없습니다.");
  }
  const subject = action === "start" ? input.subject : row.subject;
  if (typeof subject !== "string" || !subject.trim())
    return fail("SUBJECT", 400, "과목을 선택해 주세요.");
  if (["start", "resume"].includes(action) && input.confirmedAppIdle !== true)
    return fail(
      "APP_CHECK",
      400,
      "앱에서 기존 타이머가 꺼져 있는지 확인해 주세요.",
    );
  let jwt: string;
  try {
    jwt = await credential(env, s.account_id);
  } catch {
    return fail("RELOGIN", 503, "다시 로그인해 주세요.");
  }
  try {
    const info = await reload(jwt);
    const remote = remoteFrom(info);
    if (["start", "resume"].includes(action) && remote.status !== "idle")
      return fail(
        "APP_ACTIVE",
        409,
        "열품타 앱에서 실행 중인 타이머를 확인해 주세요.",
      );
    if (
      ["pause", "stop"].includes(action) &&
      (remote.status !== "running" ||
        remote.subject !== subject ||
        (row.origin === "app" && remote.startedAt !== row.started_at) ||
        (row.origin === "web" &&
          Math.abs((remote.startedAt ?? 0) - (row.started_at ?? 0)) > 3000))
    )
      return fail(
        "REMOTE_MISMATCH",
        409,
        "앱과 웹의 타이머 상태가 다릅니다. 상태를 새로고침해 주세요.",
      );
    if (
      action === "start" &&
      !subjectsFrom(info).some((s) => s.title === subject)
    )
      return fail("SUBJECT", 422, "열품타에 있는 과목을 선택해 주세요.");
  } catch (e) {
    return resultError(e);
  }
  const previous = row.state;
  const pending =
    action === "start" || action === "resume" ? "starting" : "stopping";
  const startedAt = pending === "starting" ? Date.now() : row.started_at;
  if (
    pending === "stopping" &&
    (!startedAt || !Number.isSafeInteger(startedAt))
  )
    return fail("STATE", 409, "시작 시각을 확인할 수 없습니다.");
  const changed = await env.DB.prepare(
    "UPDATE timers SET state=?,subject=?,started_at=?,origin=?,pending_id=?,revision=revision+1,updated_at=? WHERE account_id=? AND revision=? AND state=?",
  )
    .bind(
      pending,
      subject,
      startedAt,
      pending === "starting" ? "web" : row.origin,
      op,
      Date.now(),
      s.account_id,
      row.revision,
      previous,
    )
    .run();
  if (!changed.meta.changes)
    return fail("CONFLICT", 409, "다른 탭에서 처리 중입니다.");
  await env.DB.prepare(
    "INSERT INTO operations(account_id,id,action,created_at) VALUES(?,?,?,?)",
  )
    .bind(s.account_id, op, action, Date.now())
    .run();
  try {
    if (pending === "starting") await start(jwt, subject);
    else await stop(jwt, startedAt!);
    const finalState: TimerState =
      pending === "starting"
        ? "running"
        : action === "pause"
          ? "paused"
          : "idle";
    const final = await env.DB.prepare(
      "UPDATE timers SET state=?,subject=?,started_at=?,origin=?,pending_id=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND state=? AND pending_id=?",
    )
      .bind(
        finalState,
        finalState === "idle" ? null : subject,
        finalState === "running" ? startedAt : null,
        finalState === "idle"
          ? null
          : pending === "starting"
            ? "web"
            : row.origin,
        Date.now(),
        s.account_id,
        pending,
        op,
      )
      .run();
    if (!final.meta.changes) throw new YptError("UNCERTAIN");
    return json({ timer: publicTimer(await timer(env, s.account_id)) });
  } catch (e) {
    // An upstream error can mean that a mutation succeeded but its reply was lost.
    // Never retry it and never invent a stop timestamp for an app-started timer.
    await env.DB.prepare(
      "UPDATE timers SET state='uncertain',revision=revision+1,updated_at=? WHERE account_id=? AND state=? AND pending_id=?",
    )
      .bind(Date.now(), s.account_id, pending, op)
      .run();
    return e instanceof YptError && e.code === "AUTH_EXPIRED"
      ? resultError(e)
      : fail(
          "UNCERTAIN",
          503,
          "결과가 불확실합니다. 열품타 앱에서 상태를 확인해 주세요.",
        );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const path = url.pathname;
    if (path === "/api/login" && request.method === "POST") {
      try {
        return await loginRoute(request, env);
      } catch {
        return fail("SERVER_ERROR", 500, "로그인을 처리하지 못했습니다.");
      }
    }
    let s: Session | null;
    try {
      s = await session(request, env);
    } catch {
      return fail("SERVER_ERROR", 500, "세션을 확인하지 못했습니다.");
    }
    if (path === "/api/session" && request.method === "GET")
      return json(
        s ? { authenticated: true, csrf: s.csrf } : { authenticated: false },
      );
    if (!s) return fail("UNAUTHORIZED", 401, "다시 로그인해 주세요.");
    if (request.method !== "GET" && !mutationAllowed(request, env, s))
      return fail("CSRF", 403, "요청을 확인할 수 없습니다.");
    if (path === "/api/logout" && request.method === "POST") {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
        .bind(s.token_hash)
        .run();
      return json({ authenticated: false }, 200, {
        "Set-Cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
      });
    }
    try {
      const jwt = await credential(env, s.account_id);
      if (path === "/api/snapshot" && request.method === "GET") {
        const info = await reload(jwt);
        const subjects = subjectsFrom(info);
        const today = dayFrom(info.dl, subjects);
        const remote = remoteFrom(info);
        const snapshot: Snapshot = {
          timer: publicTimer(await reconcile(env, s.account_id, remote)),
          today,
          subjects,
          capabilities: {
            crossControl: true,
            history: HISTORY_VALIDATED,
            groups: true,
          },
          serverNow: Date.now(),
          remoteStatus: remote.status,
          remoteStartedAt: remote.startedAt,
          remoteSubject: remote.subject,
        };
        return json(snapshot);
      }
      if (path === "/api/history" && request.method === "GET") {
        if (!HISTORY_VALIDATED)
          return fail("UNVERIFIED", 501, "과거 날짜 조회는 검증 중입니다.");
        const date = url.searchParams.get("date") ?? "";
        const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date)
          ? Date.parse(`${date}T00:00:00Z`)
          : NaN;
        if (
          !Number.isFinite(parsedDate) ||
          new Date(parsedDate).toISOString().slice(0, 10) !== date
        )
          return fail("DATE", 400, "날짜를 확인해 주세요.");
        const day: Day = await history(jwt, date);
        return json(day);
      }
      if (path === "/api/groups" && request.method === "GET")
        return json({ groups: await groups(jwt) });
      if (
        path.startsWith("/api/groups/") &&
        path.endsWith("/members") &&
        request.method === "GET"
      ) {
        const id = Number(path.split("/")[3]);
        if (!Number.isSafeInteger(id) || id <= 0)
          return fail("GROUP", 400, "그룹을 확인해 주세요.");
        const list = await groups(jwt);
        if (!list.some((g) => g.id === id))
          return fail("GROUP", 404, "가입한 그룹이 아닙니다.");
        const info = await reload(jwt);
        const countryId = Number(info.coid);
        if (!Number.isSafeInteger(countryId) || countryId < 0)
          return fail("GROUP", 503, "그룹 정보를 확인할 수 없습니다.");
        return json({
          members: await members(jwt, id, countryId),
          checkedAt: Date.now(),
        });
      }
      const action = path.match(
        /^\/api\/timer\/(start|pause|resume|stop|resolve)$/,
      )?.[1] as "start" | "pause" | "resume" | "stop" | "resolve" | undefined;
      if (action && request.method === "POST")
        return changeTimer(action, request, env, s);
      return fail("NOT_FOUND", 404, "요청을 찾을 수 없습니다.");
    } catch (e) {
      return resultError(e);
    }
  },
};
