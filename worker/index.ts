import type { Day, Group, Member, Snapshot, Timer, TimerState } from "../shared/types.ts";
import { PENDING_RECOVERY_MS } from "../shared/constants.ts";
import {
  YptError,
  dayFrom,
  googleSocialLogin,
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
  APP_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
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
const OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const GROUP_ACCESS_TTL_MS = 5 * 60 * 1000;
const HISTORY_FETCH_CONCURRENCY = 4;
const COOKIE = "ypt_session";
const REMEMBER_COOKIE = "__Host-ypt_remember";
const PAGES_ORIGIN = "https://ypt.mcv.kr";
function rememberCookie(value: string, maxAge = TTL / 1000) {
  return `${REMEMBER_COOKIE}=${value}; HttpOnly; Secure; SameSite=None; Partitioned; Path=/; Max-Age=${maxAge}`;
}
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
function fail(code: string, status: number, message: string, headers: HeadersInit = {}) {
  return json({ code, error: message }, status, headers);
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
async function accountId(env: Env, email: string, normalize = true) {
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
        encoder.encode(normalize ? email.trim().toLowerCase() : email),
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
function cookie(request: Request, name = COOKIE) {
  return (
    request.headers
      .get("Cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? null
  );
}
async function session(request: Request, env: Env) {
  const authorization = request.headers.get("Authorization");
  const value = authorization
    ? authorization.startsWith("Bearer ") ? authorization.slice(7) : null
    : cookie(request, request.headers.get("Origin") === PAGES_ORIGIN
      ? REMEMBER_COOKIE : COOKIE);
  if (!value || !/^[0-9a-f]{64}$/.test(value)) return null;
  return env.DB.prepare(
    "SELECT token_hash, account_id, csrf, expires_at FROM sessions WHERE token_hash=? AND expires_at>?",
  )
    .bind(await sha(value), Date.now())
    .first<Session>();
}
async function cleanupExpiredSessions(env: Env) {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at<=?")
    .bind(Date.now()).run();
  await env.DB.prepare(
    "DELETE FROM accounts WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.account_id=accounts.id)",
  ).bind().run();
}
async function revokeSessionGroup(env: Env, s: Session) {
  await env.DB.prepare("DELETE FROM sessions WHERE account_id=? AND csrf=?")
    .bind(s.account_id, s.csrf).run();
}
async function revokeRememberCookie(request: Request, env: Env) {
  const value = cookie(request, REMEMBER_COOKIE);
  if (!value || !/^[0-9a-f]{64}$/.test(value)) return;
  const found = await env.DB.prepare(
    "SELECT token_hash, account_id, csrf, expires_at FROM sessions WHERE token_hash=?",
  ).bind(await sha(value)).first<Session>();
  if (found) await revokeSessionGroup(env, found);
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
async function refreshGroupAccess(env: Env, account: string, jwt: string): Promise<{
  list: Group[];
  countryId: number;
}> {
  const list = await groups(jwt);
  const info = await reload(jwt);
  const countryId = Number(info.coid);
  if (!Number.isSafeInteger(countryId) || countryId < 0)
    throw new YptError("INVALID_DATA");
  const expiresAt = Date.now() + GROUP_ACCESS_TTL_MS;
  const statements = [
    env.DB.prepare("DELETE FROM group_access_cache WHERE account_id=?").bind(account),
    ...list.map((group) => env.DB.prepare(
      "INSERT INTO group_access_cache(account_id,group_id,country_id,expires_at) VALUES(?,?,?,?)",
    ).bind(account, group.id, countryId, expiresAt)),
  ];
  await env.DB.batch(statements);
  return { list, countryId };
}
type CachedDayRow = { payload: string; fetched_at: number };
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
function shiftIsoDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function parseCachedDay(payload: string, expectedDate: string): Day | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const day = value as Day;
    if (day.date !== expectedDate || !Number.isSafeInteger(day.totalMs) || day.totalMs < 0 ||
      typeof day.subjectTimesAvailable !== "boolean" || !Array.isArray(day.subjects) ||
      !(day.longestSegmentMs === null ||
        Number.isSafeInteger(day.longestSegmentMs) && day.longestSegmentMs >= 0))
      return null;
    if (!day.subjects.every((subject) =>
      subject && typeof subject === "object" &&
      typeof subject.title === "string" && !!subject.title &&
      (subject.studyMs === null || Number.isSafeInteger(subject.studyMs) && subject.studyMs >= 0) &&
      (subject.color === undefined || typeof subject.color === "string")))
      return null;
    return day;
  } catch {
    return null;
  }
}
async function readCachedDay(env: Env, account: string, date: string) {
  const row = await env.DB.prepare(
    "SELECT payload, fetched_at FROM day_cache WHERE account_id=? AND date=?",
  ).bind(account, date).first<CachedDayRow>();
  if (!row) return null;
  const day = parseCachedDay(row.payload, date);
  if (!day) {
    await env.DB.prepare("DELETE FROM day_cache WHERE account_id=? AND date=?")
      .bind(account, date).run();
    return null;
  }
  return { day, fetchedAt: row.fetched_at };
}
async function writeCachedDay(env: Env, account: string, day: Day) {
  await env.DB.prepare(
    "INSERT INTO day_cache(account_id,date,payload,fetched_at) VALUES(?,?,?,?) " +
    "ON CONFLICT(account_id,date) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at",
  ).bind(account, day.date, JSON.stringify(day), Date.now()).run();
}
async function historyDay(env: Env, account: string, jwt: string, date: string, force = false) {
  if (!force) {
    const cached = await readCachedDay(env, account, date);
    if (cached) return { day: cached.day, cached: true, fetchedAt: cached.fetchedAt };
  }
  const day = await history(jwt, date);
  await writeCachedDay(env, account, day);
  return { day, cached: false, fetchedAt: Date.now() };
}
async function historyRange(env: Env, account: string, jwt: string, end: string, count: number, force = false) {
  const dates = Array.from({ length: count }, (_, index) => shiftIsoDate(end, -index));
  const rows: Array<{ date: string; day: Day | null; cached: boolean }> =
    dates.map((date) => ({ date, day: null, cached: false }));
  const misses: number[] = [];
  if (!force) {
    const cached = await Promise.all(dates.map((date) => readCachedDay(env, account, date)));
    cached.forEach((entry, index) => {
      if (entry) rows[index] = { date: dates[index], day: entry.day, cached: true };
      else misses.push(index);
    });
  } else {
    misses.push(...dates.map((_, index) => index));
  }

  for (let offset = 0; offset < misses.length; offset += HISTORY_FETCH_CONCURRENCY) {
    const indexes = misses.slice(offset, offset + HISTORY_FETCH_CONCURRENCY);
    const results = await Promise.allSettled(indexes.map(async (index) => {
      const day = await history(jwt, dates[index]);
      await writeCachedDay(env, account, day);
      return day;
    }));
    const authError = results.find((result) =>
      result.status === "rejected" &&
      result.reason instanceof YptError &&
      result.reason.code === "AUTH_EXPIRED");
    if (authError?.status === "rejected") throw authError.reason;
    results.forEach((result, resultIndex) => {
      const index = indexes[resultIndex];
      if (result.status === "fulfilled")
        rows[index] = { date: dates[index], day: result.value, cached: false };
    });
  }
  return {
    days: rows,
    cacheHits: rows.filter((row) => row.cached && row.day).length,
    fetched: rows.filter((row) => !row.cached && row.day).length,
  };
}
async function cachedGroupCountryId(env: Env, account: string, jwt: string, groupId: number) {
  const cached = await env.DB.prepare(
    "SELECT country_id FROM group_access_cache WHERE account_id=? AND group_id=? AND expires_at>?",
  ).bind(account, groupId, Date.now()).first<{ country_id: number }>();
  if (cached && Number.isSafeInteger(cached.country_id) && cached.country_id >= 0)
    return cached.country_id;
  const refreshed = await refreshGroupAccess(env, account, jwt);
  return refreshed.list.some((group) => group.id === groupId)
    ? refreshed.countryId : null;
}
async function groupOverview(env: Env, account: string, jwt: string): Promise<{
  groups: Group[];
  counts: Record<string, number>;
  selected: { groupId: number; members: Member[]; checkedAt: number } | null;
}> {
  const { list, countryId } = await refreshGroupAccess(env, account, jwt);
  const counts: Record<string, number> = {};
  let selected: { groupId: number; members: Member[]; checkedAt: number } | null = null;
  for (let index = 0; index < list.length; index += 2) {
    const batch = list.slice(index, index + 2);
    const results = await Promise.allSettled(batch.map(async (group) => ({
      group,
      members: await members(jwt, group.id, countryId),
      checkedAt: Date.now(),
    })));
    results.forEach((result) => {
      if (result.status !== "fulfilled") return;
      counts[String(result.value.group.id)] = result.value.members.length;
      if (result.value.group.id === list[0]?.id)
        selected = {
          groupId: result.value.group.id,
          members: result.value.members,
          checkedAt: result.value.checkedAt,
        };
    });
    const authError = results.find((result) =>
      result.status === "rejected" &&
      result.reason instanceof YptError &&
      result.reason.code === "AUTH_EXPIRED");
    if (authError?.status === "rejected") throw authError.reason;
  }
  return { groups: list, counts, selected };
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
  if (remote.status === "unverified") return current;

  if (["starting", "stopping", "uncertain"].includes(current.state)) {
    if (
      current.state !== "uncertain" &&
      Date.now() - current.updated_at < PENDING_RECOVERY_MS
    )
      return current;

    const operation = current.pending_id
      ? await env.DB.prepare(
          "SELECT action FROM operations WHERE account_id=? AND id=?",
        ).bind(account, current.pending_id).first<{ action: string }>()
      : null;
    if (
      current.state !== "uncertain" &&
      (!operation || !["start", "resume", "pause", "stop"].includes(operation.action))
    )
      return current;

    if (
      remote.status === "running" &&
      remote.startedAt !== null &&
      remote.subject
    ) {
      await env.DB.prepare(
        "UPDATE timers SET state='running',subject=?,started_at=?,origin=?,pending_id=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND revision=? AND state=?",
      ).bind(
        remote.subject,
        remote.startedAt,
        current.origin ?? "app",
        Date.now(),
        account,
        current.revision,
        current.state,
      ).run();
      return timer(env, account);
    }

    if (remote.status === "idle") {
      const paused = operation?.action === "pause" || operation?.action === "resume";
      await env.DB.prepare(
        "UPDATE timers SET state=?,subject=?,started_at=NULL,origin=?,pending_id=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND revision=? AND state=?",
      ).bind(
        paused ? "paused" : "idle",
        paused ? current.subject : null,
        paused ? current.origin : null,
        Date.now(),
        account,
        current.revision,
        current.state,
      ).run();
      return timer(env, account);
    }

    return current;
  }

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
  const url = new URL(request.url);
  const localProxy = (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    origin === env.APP_ORIGIN;
  const pages = origin === PAGES_ORIGIN &&
    (!s || /^Bearer [0-9a-f]{64}$/.test(request.headers.get("Authorization") ?? "") ||
      /^[0-9a-f]{64}$/.test(cookie(request, REMEMBER_COOKIE) ?? ""));
  return (
    !!origin &&
    (origin === url.origin || localProxy || pages) &&
    (request.headers.get("Sec-Fetch-Site") !== "cross-site" || pages) &&
    (!s || request.headers.get("X-CSRF-Token") === s.csrf)
  );
}
async function hitLoginLimit(env: Env, key: string, now: number, expiry: number) {
  await env.DB.prepare(
    "INSERT INTO login_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<? THEN 1 ELSE count+1 END, expires_at=CASE WHEN expires_at<? THEN excluded.expires_at ELSE expires_at END",
  ).bind(key, expiry, now, now).run();
  const row = await env.DB.prepare("SELECT count FROM login_limits WHERE key=?")
    .bind(key).first<{ count: number }>();
  return !!row && row.count <= 10;
}
async function limitIp(env: Env, request: Request) {
  const now = Date.now();
  const expiry = now + 15 * 60_000;
  await env.DB.prepare("DELETE FROM login_limits WHERE expires_at<=?")
    .bind(now).run();
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ipKey = await accountId(env, `ip:${ip}`);
  return hitLoginLimit(env, `ip:${ipKey}`, now, expiry);
}
async function limitIdentity(env: Env, prefix: "email" | "google", identity: string) {
  const now = Date.now();
  const expiry = now + 15 * 60_000;
  const identityKey = await accountId(env, identity);
  return hitLoginLimit(env, `${prefix}:${identityKey}`, now, expiry);
}
async function limit(env: Env, email: string, request: Request) {
  if (!(await limitIp(env, request))) return false;
  return limitIdentity(env, "email", email.trim().toLowerCase());
}
function resultError(error: unknown, headers: HeadersInit = {}) {
  if (error instanceof YptError) {
    if (error.code === "AUTH_EXPIRED")
      return fail(
        "AUTH_EXPIRED",
        401,
        "열품타 로그인이 만료됐습니다. 다시 로그인해 주세요.",
        headers,
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
  } catch (e) {
    return e instanceof YptError && (e.code === "REJECTED" || e.code === "AUTH_EXPIRED")
      ? fail("LOGIN_FAILED", 401, "열품타 계정 정보를 확인해 주세요.")
      : resultError(e);
  }
  try {
    await reload(jwt);
  } catch (e) {
    return resultError(e);
  }
  return issueSession(request, env, await accountId(env, email), jwt,
    input?.rememberDevice === true);
}

async function googleLoginRoute(request: Request, env: Env) {
  if (!env.GOOGLE_CLIENT_ID)
    return fail("NOT_CONFIGURED", 503, "Google 로그인이 아직 설정되지 않았습니다.");
  if (!mutationAllowed(request, env))
    return fail("ORIGIN", 403, "요청 출처를 확인할 수 없습니다.");
  const input = await body(request);
  const accessToken = typeof input?.accessToken === "string" ? input.accessToken : "";
  if (!accessToken || accessToken.length > 4096)
    return fail("INPUT", 400, "Google 로그인 정보를 확인해 주세요.");
  if (!(await limitIp(env, request)))
    return fail("RATE_LIMIT", 429, "로그인 시도가 많습니다. 15분 후 다시 시도해 주세요.");
  let profile: unknown;
  let tokenInfo: unknown;
  try {
    const tokenUrl = new URL("https://oauth2.googleapis.com/tokeninfo");
    tokenUrl.searchParams.set("access_token", accessToken);
    const tokenResponse = await fetch(tokenUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!tokenResponse.ok)
      return tokenResponse.status === 400 || tokenResponse.status === 401
        ? fail("GOOGLE_AUTH", 401, "Google 인증을 확인할 수 없습니다.")
        : fail("GOOGLE_UNAVAILABLE", 503, "Google 인증 서버에 연결할 수 없습니다.");
    tokenInfo = await tokenResponse.json();
    const info = object(tokenInfo);
    const expiresIn = Number(info?.expires_in);
    if (info?.aud !== env.GOOGLE_CLIENT_ID ||
        (info.azp !== undefined && info.azp !== env.GOOGLE_CLIENT_ID) ||
        !Number.isFinite(expiresIn) || expiresIn <= 0)
      return fail("GOOGLE_AUTH", 401, "Google 인증 대상을 확인할 수 없습니다.");
    const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      return response.status === 401 || response.status === 403
        ? fail("GOOGLE_AUTH", 401, "Google 인증을 확인할 수 없습니다.")
        : fail("GOOGLE_UNAVAILABLE", 503, "Google 인증 서버에 연결할 수 없습니다.");
    profile = await response.json();
  } catch {
    return fail("GOOGLE_UNAVAILABLE", 503, "Google 인증 서버에 연결할 수 없습니다.");
  }
  const user = object(profile);
  const googleId = typeof user?.sub === "string" ? user.sub : "";
  const email = typeof user?.email === "string" ? user.email : "";
  if (!googleId || googleId.length > 255 || !/^[\x21-\x7e]+$/.test(googleId) ||
      (typeof object(tokenInfo)?.sub === "string" && object(tokenInfo)?.sub !== googleId) ||
      !email || email.length > 254 ||
      user?.email_verified !== true)
    return fail("GOOGLE_AUTH", 401, "Google 계정 정보를 확인할 수 없습니다.");
  if (!(await limitIdentity(env, "google", googleId)))
    return fail("RATE_LIMIT", 429, "이 Google 계정의 로그인 시도가 많습니다. 15분 후 다시 시도해 주세요.");
  let jwt: string;
  try {
    jwt = await googleSocialLogin(accessToken, googleId, email);
    await reload(jwt);
  } catch (e) {
    return resultError(e);
  }
  return issueSession(request, env, await accountId(env, `google:${googleId}`, false), jwt,
    input?.rememberDevice === true);
}

async function issueSession(request: Request, env: Env, id: string, jwt: string,
  rememberDevice: boolean) {
  await cleanupExpiredSessions(env);
  const pages = request.headers.get("Origin") === PAGES_ORIGIN;
  const remember = pages && rememberDevice;
  const sealed = await encrypt(env, id, jwt);
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const rememberedToken = remember
    ? hex(crypto.getRandomValues(new Uint8Array(32))) : null;
  const csrf = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  if (pages) await revokeRememberCookie(request, env);
  const statements = [
    env.DB.prepare(
      "INSERT INTO accounts(id,encrypted_jwt,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET encrypted_jwt=excluded.encrypted_jwt",
    ).bind(id, sealed, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO timers(account_id,state,updated_at) VALUES(?,'idle',?)",
    ).bind(id, now),
    env.DB.prepare(
      "INSERT INTO sessions(token_hash,account_id,csrf,expires_at) VALUES(?,?,?,?)",
    ).bind(await sha(token), id, csrf, now + TTL),
  ];
  if (rememberedToken)
    statements.push(env.DB.prepare(
      "INSERT INTO sessions(token_hash,account_id,csrf,expires_at) VALUES(?,?,?,?)",
    ).bind(await sha(rememberedToken), id, csrf, now + TTL));
  await env.DB.batch(statements);
  if (pages)
    return json({ authenticated: true, csrf, sessionToken: token }, 200,
      rememberedToken ? { "Set-Cookie": rememberCookie(rememberedToken) } :
        cookie(request, REMEMBER_COOKIE) ? { "Set-Cookie": rememberCookie("", 0) } : {});
  return json({ authenticated: true, csrf }, 200, {
    "Set-Cookie": `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${TTL / 1000}`,
  });
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
    if (
      row.state !== "uncertain" &&
      Date.now() - row.updated_at < PENDING_RECOVERY_MS
    )
      return fail(
        "IN_PROGRESS",
        409,
        "요청을 처리 중입니다. 잠시 뒤 상태를 다시 확인해 주세요.",
      );
    try {
      const jwt = await credential(env, s.account_id);
      const remote = remoteFrom(await reload(jwt));
      if (remote.status === "running")
        return fail(
          "APP_ACTIVE",
          409,
          "앱에서 타이머가 실행 중입니다. 정지한 뒤 다시 확인해 주세요.",
        );
      if (remote.status !== "idle")
        return fail(
          "REMOTE_UNVERIFIED",
          503,
          "앱 타이머 상태를 확인할 수 없습니다. 잠시 뒤 다시 확인해 주세요.",
        );
    } catch (e) {
      if (e instanceof YptError && e.code === "AUTH_EXPIRED") throw e;
      return resultError(e);
    }
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
  const stopPaused = action === "stop" && row.state === "paused";
  if (
    (action === "start" && row.state !== "idle") ||
    (action === "resume" && row.state !== "paused") ||
    (["pause", "stop"].includes(action) &&
      row.state !== "running" &&
      !stopPaused)
  )
    return fail("STATE", 409, "현재 상태에서는 실행할 수 없습니다.");
  const subject = action === "start" ? input.subject : row.subject;
  if (typeof subject !== "string" || !subject.trim())
    return fail("SUBJECT", 400, "과목을 선택해 주세요.");
  await env.DB.prepare(
    "DELETE FROM operations WHERE account_id=? AND created_at<?",
  )
    .bind(s.account_id, Date.now() - OPERATION_RETENTION_MS)
    .run();
  let jwt: string;
  try {
    jwt = await credential(env, s.account_id);
  } catch {
    return fail("RELOGIN", 503, "다시 로그인해 주세요.");
  }
  try {
    const info = await reload(jwt);
    const remote = remoteFrom(info);
    if (stopPaused) {
      if (remote.status !== "idle")
        return fail(
          "REMOTE_MISMATCH",
          409,
          "앱 타이머 상태가 다릅니다. 상태를 새로고침해 주세요.",
        );
      const done = await env.DB.prepare(
        "UPDATE timers SET state='idle',subject=NULL,started_at=NULL,origin=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND revision=? AND state='paused'",
      )
        .bind(Date.now(), s.account_id, row.revision)
        .run();
      return done.meta.changes
        ? json({ timer: publicTimer(await timer(env, s.account_id)) })
        : fail("CONFLICT", 409, "상태가 변경됐습니다.");
    }
    if (["start", "resume"].includes(action) && remote.status === "unverified")
      return fail(
        "REMOTE_UNVERIFIED",
        503,
        "앱 타이머 상태를 확인할 수 없습니다. 잠시 뒤 다시 확인해 주세요.",
      );
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
    if (e instanceof YptError && e.code === "AUTH_EXPIRED") throw e;
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
  let mutationRejected = false;
  try {
    let confirmedStartedAt = startedAt;
    if (pending === "starting") {
      try {
        await start(jwt, subject);
      } catch (error) {
        mutationRejected = error instanceof YptError && error.code === "REJECTED";
        throw error;
      }
      const confirmed = remoteFrom(await reload(jwt));
      if (
        confirmed.status !== "running" ||
        confirmed.subject !== subject ||
        confirmed.startedAt === null
      )
        throw new YptError("UNCERTAIN");
      confirmedStartedAt = confirmed.startedAt;
    } else {
      try {
        await stop(jwt, startedAt!);
      } catch (error) {
        mutationRejected = error instanceof YptError && error.code === "REJECTED";
        throw error;
      }
    }
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
        finalState === "running" ? confirmedStartedAt : null,
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
    let verificationError: unknown;
    if (e instanceof YptError && e.code === "REJECTED" && mutationRejected) {
      try {
        const remote = remoteFrom(await reload(jwt));
        if (
          remote.status === "running" &&
          remote.startedAt !== null &&
          remote.subject
        ) {
          const sameTimer = previous === "running" && row.subject === remote.subject &&
            row.started_at !== null &&
            Math.abs(remote.startedAt - row.started_at) <= (row.origin === "app" ? 0 : 3000);
          const repaired = await env.DB.prepare(
            "UPDATE timers SET state='running',subject=?,started_at=?,origin=?,pending_id=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND state=? AND pending_id=?",
          )
            .bind(
              remote.subject,
              remote.startedAt,
              sameTimer && row.origin ? row.origin : "app",
              Date.now(),
              s.account_id,
              pending,
              op,
            )
            .run();
          if (repaired.meta.changes) return resultError(e);
        } else if (remote.status === "idle") {
          const restoredState = pending === "starting" ? previous : "idle";
          const restored = await env.DB.prepare(
            "UPDATE timers SET state=?,subject=?,started_at=?,origin=?,pending_id=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND state=? AND pending_id=?",
          )
            .bind(
              restoredState,
              restoredState === "idle" ? null : row.subject,
              restoredState === "running" ? row.started_at : null,
              restoredState === "idle" ? null : row.origin,
              Date.now(),
              s.account_id,
              pending,
              op,
            )
            .run();
          if (restored.meta.changes) return resultError(e);
        }
      } catch (error) {
        // Keep the timer uncertain if the read-only verification cannot confirm a state.
        verificationError = error;
      }
    }
    // An upstream error can mean that a mutation succeeded but its reply was lost.
    // Never retry it and never invent a stop timestamp for an app-started timer.
    await env.DB.prepare(
      "UPDATE timers SET state='uncertain',revision=revision+1,updated_at=? WHERE account_id=? AND state=? AND pending_id=?",
    )
      .bind(Date.now(), s.account_id, pending, op)
      .run();
    if (e instanceof YptError && e.code === "AUTH_EXPIRED") throw e;
    if (verificationError instanceof YptError && verificationError.code === "AUTH_EXPIRED")
      throw verificationError;
    return fail(
      "UNCERTAIN",
      503,
      "결과가 불확실합니다. 열품타 앱에서 상태를 확인해 주세요.",
    );
  }
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
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
    if (path === "/api/auth/providers" && request.method === "GET")
      return json({ googleClientId: env.GOOGLE_CLIENT_ID || null });
    if (path === "/api/login/google" && request.method === "POST") {
      try {
        return await googleLoginRoute(request, env);
      } catch {
        return fail("SERVER_ERROR", 500, "Google 로그인을 처리하지 못했습니다.");
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
        200,
        !s && request.headers.get("Origin") === PAGES_ORIGIN &&
          !request.headers.get("Authorization") && cookie(request, REMEMBER_COOKIE)
          ? { "Set-Cookie": rememberCookie("", 0) } : {},
      );
    if (!s) return fail("UNAUTHORIZED", 401, "다시 로그인해 주세요.");
    if (request.method !== "GET" && !mutationAllowed(request, env, s))
      return fail("CSRF", 403, "요청을 확인할 수 없습니다.");
    if (path === "/api/logout" && request.method === "POST") {
      await revokeSessionGroup(env, s);
      await cleanupExpiredSessions(env);
      const pages = request.headers.get("Origin") === PAGES_ORIGIN;
      if (pages) await revokeRememberCookie(request, env);
      return json({ authenticated: false }, 200, {
        "Set-Cookie": pages ? rememberCookie("", 0) :
          `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
      });
    }
    try {
      const jwt = await credential(env, s.account_id);
      if (path === "/api/snapshot" && request.method === "GET") {
        let upstreamClockOffsetMs: number | null = null;
        const info = await reload(jwt, (offset) => {
          upstreamClockOffsetMs = offset;
        });
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
          upstreamClockOffsetMs,
          remoteStatus: remote.status,
          remoteStartedAt: remote.startedAt,
          remoteSubject: remote.subject,
        };
        return json(snapshot);
      }
      if (path === "/api/history/range" && request.method === "GET") {
        if (!HISTORY_VALIDATED)
          return fail("UNVERIFIED", 501, "과거 날짜 조회는 검증 중입니다.");
        const end = url.searchParams.get("end") ?? "";
        const count = Number(url.searchParams.get("days") ?? "");
        if (!validDate(end) || !Number.isSafeInteger(count) || count < 1 || count > 30)
          return fail("DATE", 400, "기간을 확인해 주세요.");
        return json(await historyRange(
          env,
          s.account_id,
          jwt,
          end,
          count,
          url.searchParams.get("refresh") === "1",
        ));
      }
      if (path === "/api/history" && request.method === "GET") {
        if (!HISTORY_VALIDATED)
          return fail("UNVERIFIED", 501, "과거 날짜 조회는 검증 중입니다.");
        const date = url.searchParams.get("date") ?? "";
        if (!validDate(date))
          return fail("DATE", 400, "날짜를 확인해 주세요.");
        const result = await historyDay(
          env,
          s.account_id,
          jwt,
          date,
          url.searchParams.get("refresh") === "1",
        );
        return json(result.day);
      }
      if (path === "/api/groups/overview" && request.method === "GET")
        return json(await groupOverview(env, s.account_id, jwt));
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
        const countryId = await cachedGroupCountryId(env, s.account_id, jwt, id);
        if (countryId === null)
          return fail("GROUP", 404, "가입한 그룹이 아닙니다.");
        return json({
          members: await members(jwt, id, countryId),
          checkedAt: Date.now(),
        });
      }
      const action = path.match(
        /^\/api\/timer\/(start|pause|resume|stop|resolve)$/,
      )?.[1] as "start" | "pause" | "resume" | "stop" | "resolve" | undefined;
      if (action && request.method === "POST")
        return await changeTimer(action, request, env, s);
      return fail("NOT_FOUND", 404, "요청을 찾을 수 없습니다.");
    } catch (e) {
      if (e instanceof YptError && e.code === "AUTH_EXPIRED") {
        await revokeSessionGroup(env, s);
        await cleanupExpiredSessions(env);
        const pages = request.headers.get("Origin") === PAGES_ORIGIN;
        if (pages) await revokeRememberCookie(request, env);
        return resultError(e, {
          "Set-Cookie": pages ? rememberCookie("", 0) :
            `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
        });
      }
      return resultError(e);
    }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const api = new URL(request.url).pathname.startsWith("/api/");
    if (api && request.method === "OPTIONS") {
      if (origin !== PAGES_ORIGIN)
        return fail("ORIGIN", 403, "요청 출처를 확인할 수 없습니다.");
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": PAGES_ORIGIN,
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, X-CSRF-Token",
          "Access-Control-Max-Age": "600",
          "Vary": "Origin",
        },
      });
    }
    const response = await handleRequest(request, env);
    if (!api || origin !== PAGES_ORIGIN) return response;
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", PAGES_ORIGIN);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.append("Vary", "Origin");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
