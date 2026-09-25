import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import worker from "../worker/index.ts";
import { PENDING_RECOVERY_MS } from "../shared/constants.ts";

const origin = "https://study.example";
function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(
      new URL("../worker/migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...values) {
          return {
            first: async () => statement.get(...values) ?? null,
            run: async () => ({
              meta: { changes: Number(statement.run(...values).changes) },
            }),
          };
        },
      };
    },
    async batch(statements) {
      return Promise.all(statements.map((s) => s.run()));
    },
  };
}
function upstream() {
  const users = new Map();
  let dropStartResponse = false;
  let dropStopResponse = false;
  let nextStartOffsetMs = 0;
  let nextStartTimestamp = null;
  let hideActiveStartTimeOnce = false;
  let expireAfterNextStart = false;
  const reply = (data) =>
    new Response(JSON.stringify({ s: true, ...data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const fetch = async (input, options) => {
    const path = new URL(input).pathname;
    const inputBody = options?.body ? JSON.parse(options.body) : {};
    if (path === "/user/sign-in-jwt") {
      if (inputBody.password !== "correct")
        return new Response(JSON.stringify({ s: false, c: 113 }), {
          status: 200,
        });
      const token = `jwt-${inputBody.email}`;
      if (!users.has(token))
        users.set(token, {
          active: false,
          subject: null,
          startedAt: null,
          total: 0,
          segments: [],
        });
      return reply({ jwt: token });
    }
    const token = options.headers.Authorization?.replace("JWT ", "");
    const state = users.get(token);
    if (!state)
      return new Response(JSON.stringify({ s: false, c: 112 }), {
        status: 401,
      });
    if (path === "/user/v2/reload/info") {
      const hideStartTime = hideActiveStartTimeOnce && state.active;
      if (hideStartTime) hideActiveStartTimeOnce = false;
      return reply({
        p: {
          is: state.active,
          st: state.startedAt && !hideStartTime ? new Date(state.startedAt).toISOString() : "",
          sb: state.subject || "",
        },
        ss: [{ tt: "수학", dl: false, sm: 0 }],
        coid: 82,
        dl: { dt: "2026-09-24", sm: state.total, ls: state.segments },
      });
    }
    if (path === "/study/start") {
      if (state.active)
        return new Response(JSON.stringify({ s: false, c: 104 }), {
          status: 200,
        });
      state.active = true;
      state.subject = inputBody.subject;
      state.startedAt = nextStartTimestamp ?? Date.now() + nextStartOffsetMs;
      nextStartOffsetMs = 0;
      nextStartTimestamp = null;
      if (expireAfterNextStart) {
        expireAfterNextStart = false;
        users.delete(token);
      }
      if (dropStartResponse) {
        dropStartResponse = false;
        throw new Error("lost response");
      }
      return reply({
        dl: { dt: "2026-09-24", sm: state.total, ls: state.segments },
      });
    }
    if (path === "/study/stop") {
      if (
        !state.active ||
        Math.abs(inputBody.startedAt - state.startedAt) > 3000
      )
        return new Response(JSON.stringify({ s: false, c: 104 }), {
          status: 200,
        });
      const elapsed = Math.max(1, Date.now() - state.startedAt);
      state.total += elapsed;
      state.segments.push({ sb: state.subject, sm: elapsed });
      state.active = false;
      if (dropStopResponse) {
        dropStopResponse = false;
        throw new Error("lost response");
      }
      return reply({
        dl: { dt: "2026-09-24", sm: state.total, ls: state.segments },
      });
    }
    if (path === "/group/groups/v2")
      return token === "jwt-a@example.test"
        ? reply({
            gs: [{ id: 7, t: "공부방", mc: 4 }],
            ms: [], cs: [], ps: [],
          })
        : reply({ gs: [], ms: [], cs: [], ps: [] });
    if (path === "/logs/group/members/v2") {
      const url = new URL(input);
      if (
        url.searchParams.get("groupID") !== "7" ||
        url.searchParams.get("countryID") !== "82"
      )
        throw new Error("wrong group member request");
      return reply({
        ms: [
          { ud: 1, n: "멤버1", im: true, dl: { is: false, sm: 1000 } },
          { ud: 2, n: "멤버2", im: true, dl: { sm: 2000 } },
          { ud: 3, n: "멤버3", im: true, dl: { sm: 3000 } },
          { ud: 4, n: "멤버4", im: true, dl: { sm: 4000 } },
        ],
      });
    }
    if (path === "/logs/day")
      return reply({ dl: { dt: new URL(input).searchParams.get("date"), sm: 69_946, ls: [{ sb: "수학", sm: 69_946 }] } });
    throw new Error(`unexpected ${path}`);
  };
  return {
    users,
    fetch,
    loseNextStart() {
      dropStartResponse = true;
    },
    loseNextStop() {
      dropStopResponse = true;
    },
    offsetNextStart(ms) {
      nextStartOffsetMs = ms;
    },
    keepNextStartAt(timestamp) {
      nextStartTimestamp = timestamp;
    },
    hideNextStartTime() {
      hideActiveStartTimeOnce = true;
    },
    expireAfterNextStart() {
      expireAfterNextStart = true;
    },
  };
}
function request(path, method = "GET", data, cookie, csrf, reqOrigin = origin) {
  return new Request(`${origin}/api${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== "GET"
        ? {
            Origin: reqOrigin,
            "X-CSRF-Token": csrf ?? "",
            "Content-Type": "application/json",
          }
        : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
}
async function call(env, path, method = "GET", data, cookie, csrf, reqOrigin) {
  const response = await worker.fetch(
    request(path, method, data, cookie, csrf, reqOrigin),
    env,
  );
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("Set-Cookie")?.split(";")[0],
  };
}

async function pagesCall(env, path, method = "GET", data, token, csrf, reqOrigin = "https://ypt.mcv.kr", rememberedCookie) {
  const response = await worker.fetch(
    new Request(`https://ypt-web.example/api${path}`, {
      method,
      headers: {
        Origin: reqOrigin,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(rememberedCookie ? { Cookie: rememberedCookie } : {}),
        ...(method !== "GET" ? {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf ?? "",
          "Sec-Fetch-Site": "cross-site",
        } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    }),
    env,
  );
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("Set-Cookie"),
    allowOrigin: response.headers.get("Access-Control-Allow-Origin"),
    allowCredentials: response.headers.get("Access-Control-Allow-Credentials"),
  };
}

test("Pages uses isolated bearer sessions and restricted CORS", async () => {
  const stub = upstream();
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  const env = {
    DB: database(),
    YPT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ASSETS: { fetch: () => new Response("page") },
  };
  try {
    const preflight = await worker.fetch(new Request("https://ypt-web.example/api/login", {
      method: "OPTIONS",
      headers: {
        Origin: "https://ypt.mcv.kr",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }), env);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://ypt.mcv.kr");
    assert.equal(preflight.headers.get("Access-Control-Allow-Credentials"), "true");
    const rejected = await worker.fetch(new Request("https://ypt-web.example/api/login", {
      method: "OPTIONS", headers: { Origin: "https://evil.example" },
    }), env);
    assert.equal(rejected.status, 403);
    const a = await pagesCall(env, "/login", "POST", { email: "a@example.test", password: "correct" });
    const b = await pagesCall(env, "/login", "POST", { email: "b@example.test", password: "correct" });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.cookie, null);
    assert.equal(a.allowOrigin, "https://ypt.mcv.kr");
    assert.match(a.data.sessionToken, /^[0-9a-f]{64}$/);
    assert.notEqual(a.data.sessionToken, b.data.sessionToken);
    assert.equal("jwt" in a.data, false);
    assert.equal("password" in a.data, false);
    assert.equal((await pagesCall(env, "/session", "GET", undefined, a.data.sessionToken)).data.authenticated, true);
    const start = await pagesCall(env, "/timer/start", "POST", {
      revision: 0, operationId: randomUUID(), subject: "수학",
    }, a.data.sessionToken, a.data.csrf);
    assert.equal(start.status, 200);
    assert.equal((await pagesCall(env, "/snapshot", "GET", undefined, b.data.sessionToken)).data.timer.state, "idle");
    assert.equal((await pagesCall(env, "/timer/start", "POST", {
      revision: 0, operationId: randomUUID(), subject: "수학",
    }, b.data.sessionToken, a.data.csrf)).status, 403);
    const wrongOrigin = await pagesCall(env, "/timer/stop", "POST", {
      revision: start.data.timer.revision, operationId: randomUUID(),
    }, a.data.sessionToken, a.data.csrf, "https://evil.example");
    assert.equal(wrongOrigin.status, 403);
    assert.equal(wrongOrigin.allowOrigin, null);
    assert.equal((await pagesCall(env, "/logout", "POST", {}, a.data.sessionToken, a.data.csrf)).status, 200);
    assert.equal((await pagesCall(env, "/session", "GET", undefined, a.data.sessionToken)).data.authenticated, false);
    env.DB.sqlite.close();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("remembered Pages cookie restores a new tab and revokes linked sessions", async () => {
  const stub = upstream();
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  const env = {
    DB: database(),
    YPT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ASSETS: { fetch: () => new Response("page") },
  };
  const pageOrigin = "https://ypt.mcv.kr";
  try {
    const login = await pagesCall(env, "/login", "POST", {
      email: "a@example.test", password: "correct", rememberDevice: true,
    });
    assert.equal(login.status, 200);
    assert.equal(login.allowCredentials, "true");
    assert.match(login.cookie, /^__Host-ypt_remember=[0-9a-f]{64};/);
    assert.match(login.cookie, /HttpOnly; Secure; SameSite=None; Partitioned; Path=\/; Max-Age=2592000/);
    const rememberedCookie = login.cookie.split(";")[0];
    assert.notEqual(rememberedCookie.split("=")[1], login.data.sessionToken);
    const restored = await pagesCall(env, "/session", "GET", undefined,
      undefined, undefined, pageOrigin, rememberedCookie);
    assert.equal(restored.data.authenticated, true);
    assert.equal(restored.data.csrf, login.data.csrf);
    const other = await pagesCall(env, "/login", "POST", {
      email: "b@example.test", password: "correct", rememberDevice: false,
    });
    assert.equal(other.cookie, null);
    assert.equal((await pagesCall(env, "/timer/start", "POST", {
      revision: 0, operationId: randomUUID(), subject: "\uC218\uD559",
    }, undefined, "bad-csrf", pageOrigin, rememberedCookie)).status, 403);
    assert.equal((await pagesCall(env, "/timer/start", "POST", {
      revision: 0, operationId: randomUUID(), subject: "\uC218\uD559",
    }, undefined, restored.data.csrf, "https://evil.example", rememberedCookie)).status, 401);
    const started = await pagesCall(env, "/timer/start", "POST", {
      revision: 0, operationId: randomUUID(), subject: "\uC218\uD559",
    }, undefined, restored.data.csrf, pageOrigin, rememberedCookie);
    assert.equal(started.status, 200);
    assert.equal((await pagesCall(env, "/snapshot", "GET", undefined,
      other.data.sessionToken)).data.timer.state, "idle");
    const loggedOut = await pagesCall(env, "/logout", "POST", {},
      undefined, restored.data.csrf, pageOrigin, rememberedCookie);
    assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.cookie, /Max-Age=0/);
    assert.equal((await pagesCall(env, "/session", "GET", undefined,
      undefined, undefined, pageOrigin, rememberedCookie)).data.authenticated, false);
    assert.equal((await pagesCall(env, "/session", "GET", undefined,
      login.data.sessionToken)).data.authenticated, false);
    assert.equal((await pagesCall(env, "/session", "GET", undefined,
      other.data.sessionToken)).data.authenticated, true);
    const rememberedAgain = await pagesCall(env, "/login", "POST", {
      email: "a@example.test", password: "correct", rememberDevice: true,
    });
    const oldCookie = rememberedAgain.cookie.split(";")[0];
    const optedOut = await pagesCall(env, "/login", "POST", {
      email: "a@example.test", password: "correct", rememberDevice: false,
    }, undefined, undefined, pageOrigin, oldCookie);
    assert.equal(optedOut.status, 200);
    assert.match(optedOut.cookie, /Max-Age=0/);
    assert.equal((await pagesCall(env, "/session", "GET", undefined,
      rememberedAgain.data.sessionToken)).data.authenticated, false);
    assert.equal((await pagesCall(env, "/session", "GET", undefined,
      undefined, undefined, pageOrigin, oldCookie)).data.authenticated, false);
    const expiring = await pagesCall(env, "/login", "POST", {
      email: "a@example.test", password: "correct", rememberDevice: true,
    });
    env.DB.sqlite.prepare("UPDATE sessions SET expires_at=? WHERE csrf=?")
      .run(Date.now() - 1, expiring.data.csrf);
    const expired = await pagesCall(env, "/session", "GET", undefined,
      undefined, undefined, pageOrigin, expiring.cookie.split(";")[0]);
    assert.equal(expired.data.authenticated, false);
    assert.match(expired.cookie, /Max-Age=0/);
    const upstreamExpired = await pagesCall(env, "/login", "POST", {
      email: "a@example.test", password: "correct", rememberDevice: true,
    });
    const upstreamCookie = upstreamExpired.cookie.split(";")[0];
    stub.users.delete("jwt-a@example.test");
    const rejected = await pagesCall(env, "/snapshot", "GET", undefined,
      undefined, undefined, pageOrigin, upstreamCookie);
    assert.equal(rejected.status, 401);
    assert.equal(rejected.data.code, "AUTH_EXPIRED");
    assert.match(rejected.cookie, /Max-Age=0/);
    assert.equal((await pagesCall(env, "/session", "GET", undefined,
      upstreamExpired.data.sessionToken)).data.authenticated, false);
    assert.equal((await pagesCall(env, "/session", "GET", undefined,
      undefined, undefined, pageOrigin, upstreamCookie)).data.authenticated, false);
    env.DB.sqlite.close();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("timer auth expiry revokes both remembered and current-tab sessions", async () => {
  const stub = upstream();
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  const env = {
    DB: database(),
    YPT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ASSETS: { fetch: () => new Response("page") },
  };
  try {
    const login = await pagesCall(env, "/login", "POST", {
      email: "a@example.test", password: "correct", rememberDevice: true,
    });
    assert.equal(login.status, 200);
    const rememberedCookie = login.cookie.split(";")[0];
    stub.users.delete("jwt-a@example.test");
    const expired = await pagesCall(env, "/timer/start", "POST", {
      revision: 0, operationId: randomUUID(), subject: "\uC218\uD559",
    }, undefined, login.data.csrf, "https://ypt.mcv.kr", rememberedCookie);
    assert.equal(expired.status, 401);
    assert.equal(expired.data.code, "AUTH_EXPIRED");
    assert.match(expired.cookie, /Max-Age=0/);
    assert.equal((await pagesCall(env, "/session", "GET", undefined,
      login.data.sessionToken)).data.authenticated, false);
    assert.equal((await pagesCall(env, "/session", "GET", undefined,
      undefined, undefined, "https://ypt.mcv.kr", rememberedCookie)).data.authenticated, false);
    const nextLogin = await pagesCall(env, "/login", "POST", {
      email: "a@example.test", password: "correct", rememberDevice: true,
    });
    assert.equal(nextLogin.status, 200);
    stub.expireAfterNextStart();
    const expiredAfterStart = await pagesCall(env, "/timer/start", "POST", {
      revision: 0, operationId: randomUUID(), subject: "\uC218\uD559",
    }, undefined, nextLogin.data.csrf, "https://ypt.mcv.kr", nextLogin.cookie.split(";")[0]);
    assert.equal(expiredAfterStart.status, 401);
    assert.equal(expiredAfterStart.data.code, "AUTH_EXPIRED");
    assert.match(expiredAfterStart.cookie, /Max-Age=0/);
    assert.equal((await pagesCall(env, "/session", "GET", undefined,
      nextLogin.data.sessionToken)).data.authenticated, false);
    assert.equal(env.DB.sqlite.prepare("SELECT state FROM timers").get().state, "uncertain");
    env.DB.sqlite.close();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("login, account isolation, timer transitions, app adoption, and response loss", async () => {
  const stub = upstream();
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  const env = {
    DB: database(),
    APP_ORIGIN: origin,
    YPT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ASSETS: { fetch: () => new Response("page") },
  };
  try {
    assert.equal(
      (
        await call(env, "/login", "POST", {
          email: "a@example.test",
          password: "wrong",
        })
      ).status,
      401,
    );
    const loginA = await call(env, "/login", "POST", {
      email: "a@example.test",
      password: "correct",
    });
    assert.equal(loginA.status, 200);
    assert.ok(loginA.cookie?.startsWith("ypt_session="));
    const a = { cookie: loginA.cookie, csrf: loginA.data.csrf };
    const loginB = await call(env, "/login", "POST", {
      email: "b@example.test",
      password: "correct",
    });
    assert.equal(loginB.status, 200);
    const b = { cookie: loginB.cookie, csrf: loginB.data.csrf };
    const loginASecondTab = await call(env, "/login", "POST", {
      email: "a@example.test",
      password: "correct",
    });
    const aSecondTab = {
      cookie: loginASecondTab.cookie,
      csrf: loginASecondTab.data.csrf,
    };
    assert.equal(
      (await call(env, "/snapshot", "GET", undefined, a.cookie)).data.timer
        .state,
      "idle",
    );
    assert.equal(
      (
        await call(
          env,
          "/timer/start",
          "POST",
          {
            revision: 0,
            operationId: randomUUID(),
            subject: "수학",
          },
          a.cookie,
          a.csrf,
          "https://wrong.example",
        )
      ).status,
      403,
    );
    stub.offsetNextStart(-5_000);
    const id = randomUUID();
    const start = await call(
      env,
      "/timer/start",
      "POST",
      { revision: 0, operationId: id, subject: "수학" },
      a.cookie,
      a.csrf,
    );
    assert.equal(start.status, 200);
    assert.equal(start.data.timer.state, "running");
    assert.equal(
      start.data.timer.startedAt,
      stub.users.get("jwt-a@example.test").startedAt,
    );
    assert.equal(
      (
        await call(
          env,
          "/timer/start",
          "POST",
          {
            revision: 0,
            operationId: id,
            subject: "수학",
          },
          a.cookie,
          a.csrf,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          env,
          "/timer/start",
          "POST",
          {
            revision: 0,
            operationId: randomUUID(),
            subject: "수학",
          },
          aSecondTab.cookie,
          aSecondTab.csrf,
        )
      ).status,
      409,
    );
    assert.equal(
      (await call(env, "/snapshot", "GET", undefined, aSecondTab.cookie)).data
        .timer.state,
      "running",
    );
    assert.equal(
      (await call(env, "/snapshot", "GET", undefined, b.cookie)).data.timer
        .state,
      "idle",
    );
    assert.equal(
      (await call(env, "/history?date=2026-02-30", "GET", undefined, a.cookie))
        .status,
      400,
    );
    const historical = await call(
      env, "/history?date=2026-09-24", "GET", undefined, a.cookie,
    );
    assert.equal(historical.status, 200);
    assert.equal(historical.data.totalMs, 69_946);
    assert.deepEqual(historical.data.subjects, [
      { title: "수학", studyMs: 69_946 },
    ]);
    assert.equal(
      (await call(env, "/groups/123/members", "GET", undefined, a.cookie))
        .status,
      404,
    );
    const joinedGroups = await call(env, "/groups", "GET", undefined, a.cookie);
    assert.deepEqual(joinedGroups.data.groups, [
      { id: 7, title: "공부방", capacity: 4 },
    ]);
    const groupMembers = await call(
      env, "/groups/7/members", "GET", undefined, a.cookie,
    );
    assert.equal(groupMembers.status, 200);
    assert.equal(groupMembers.data.members.length, 4);
    assert.equal(groupMembers.data.members[0].studying, false);
    assert.equal(groupMembers.data.members[0].startedAt, null);
    assert.equal(groupMembers.data.members[0].studyMs, 1000);
    assert.deepEqual(
      (await call(env, "/groups", "GET", undefined, b.cookie)).data.groups,
      [],
    );
    assert.equal(
      (await call(env, "/groups/7/members", "GET", undefined, b.cookie))
        .status,
      404,
    );
    const pause = await call(
      env,
      "/timer/pause",
      "POST",
      { revision: start.data.timer.revision, operationId: randomUUID() },
      a.cookie,
      a.csrf,
    );
    assert.equal(pause.status, 200);
    assert.equal(pause.data.timer.state, "paused");
    const app = stub.users.get("jwt-a@example.test");
    app.active = true;
    app.subject = "수학";
    app.startedAt = Date.now() - 2_000;
    const conflictingPausedStop = await call(
      env,
      "/timer/stop",
      "POST",
      { revision: pause.data.timer.revision, operationId: randomUUID() },
      a.cookie,
      a.csrf,
    );
    assert.equal(conflictingPausedStop.status, 409);
    assert.equal(conflictingPausedStop.data.code, "REMOTE_MISMATCH");
    app.active = false;
    // If YPT preserves the earlier start across a short pause, display that
    // verified timestamp rather than inventing a new one locally.
    stub.keepNextStartAt(start.data.timer.startedAt);
    const resume = await call(
      env,
      "/timer/resume",
      "POST",
      {
        revision: pause.data.timer.revision,
        operationId: randomUUID(),
      },
      a.cookie,
      a.csrf,
    );
    assert.equal(resume.status, 200);
    assert.equal(resume.data.timer.state, "running");
    assert.equal(resume.data.timer.startedAt, start.data.timer.startedAt);
    assert.equal(resume.data.timer.startedAt, app.startedAt);
    const stop = await call(
      env,
      "/timer/stop",
      "POST",
      { revision: resume.data.timer.revision, operationId: randomUUID() },
      a.cookie,
      a.csrf,
    );
    assert.equal(stop.status, 200);
    assert.equal(stop.data.timer.state, "idle");
    const quickStart = await call(
      env,
      "/timer/start",
      "POST",
      {
        revision: stop.data.timer.revision,
        operationId: randomUUID(),
        subject: "수학",
      },
      a.cookie,
      a.csrf,
    );
    assert.equal(quickStart.status, 200);
    const quickPause = await call(
      env,
      "/timer/pause",
      "POST",
      { revision: quickStart.data.timer.revision, operationId: randomUUID() },
      a.cookie,
      a.csrf,
    );
    assert.equal(quickPause.status, 200);
    const endPaused = await call(
      env,
      "/timer/stop",
      "POST",
      { revision: quickPause.data.timer.revision, operationId: randomUUID() },
      a.cookie,
      a.csrf,
    );
    assert.equal(endPaused.status, 200);
    assert.equal(endPaused.data.timer.state, "idle");
    app.active = true;
    app.subject = "수학";
    app.startedAt = Date.now() - 5000;
    const blockedStart = await call(
      env,
      "/timer/start",
      "POST",
      {
        revision: endPaused.data.timer.revision,
        operationId: randomUUID(),
        subject: "수학",
      },
      a.cookie,
      a.csrf,
    );
    assert.equal(blockedStart.status, 409);
    assert.equal(blockedStart.data.code, "APP_ACTIVE");
    const adopted = await call(env, "/snapshot", "GET", undefined, a.cookie);
    assert.equal(adopted.data.timer.origin, "app");
    assert.equal(adopted.data.timer.startedAt, app.startedAt);
    const crossStop = await call(
      env,
      "/timer/stop",
      "POST",
      { revision: adopted.data.timer.revision, operationId: randomUUID() },
      a.cookie,
      a.csrf,
    );
    assert.equal(crossStop.status, 200);
    assert.equal(app.active, false);
    stub.loseNextStart();
    const lost = await call(
      env,
      "/timer/start",
      "POST",
      {
        revision: crossStop.data.timer.revision,
        operationId: randomUUID(),
        subject: "수학",
      },
      a.cookie,
      a.csrf,
    );
    assert.equal(lost.status, 503);
    assert.equal(lost.data.code, "UNCERTAIN");
    assert.equal(app.active, true);
    assert.equal(
      (await call(env, "/snapshot", "GET", undefined, a.cookie)).data.timer
        .state,
      "uncertain",
    );
    const activeRecovery = await call(
      env,
      "/timer/resolve",
      "POST",
      { confirmedStopped: true },
      a.cookie,
      a.csrf,
    );
    assert.equal(activeRecovery.status, 409);
    assert.equal(activeRecovery.data.code, "APP_ACTIVE");
    assert.equal(
      (
        await call(
          env,
          "/timer/start",
          "POST",
          {
            revision: crossStop.data.timer.revision,
            operationId: randomUUID(),
            subject: "수학",
          },
          a.cookie,
          a.csrf,
        )
      ).status,
      409,
    );
    app.active = false;
    const resolved = await call(
      env,
      "/timer/resolve",
      "POST",
      { confirmedStopped: true },
      a.cookie,
      a.csrf,
    );
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.timer.state, "idle");
    stub.hideNextStartTime();
    const unverifiedStart = await call(
      env,
      "/timer/start",
      "POST",
      {
        revision: resolved.data.timer.revision,
        operationId: randomUUID(),
        subject: "수학",
      },
      a.cookie,
      a.csrf,
    );
    assert.equal(unverifiedStart.status, 503);
    assert.equal(unverifiedStart.data.code, "UNCERTAIN");
    assert.equal(app.active, true);
    app.active = false;
    const resolvedUnverified = await call(
      env,
      "/timer/resolve",
      "POST",
      { confirmedStopped: true },
      a.cookie,
      a.csrf,
    );
    assert.equal(resolvedUnverified.status, 200);
    const startForLostStop = await call(
      env,
      "/timer/start",
      "POST",
      {
        revision: resolvedUnverified.data.timer.revision,
        operationId: randomUUID(),
        subject: "수학",
      },
      a.cookie,
      a.csrf,
    );
    assert.equal(startForLostStop.status, 200);
    stub.loseNextStop();
    const lostStop = await call(
      env,
      "/timer/stop",
      "POST",
      {
        revision: startForLostStop.data.timer.revision,
        operationId: randomUUID(),
      },
      a.cookie,
      a.csrf,
    );
    assert.equal(lostStop.status, 503);
    assert.equal(lostStop.data.code, "UNCERTAIN");
    assert.equal(app.active, false);
    assert.equal(
      (await call(env, "/snapshot", "GET", undefined, a.cookie)).data.timer
        .state,
      "uncertain",
    );
    assert.equal(
      (
        await call(
          env,
          "/timer/resolve",
          "POST",
          { confirmedStopped: true },
          a.cookie,
          a.csrf,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call(env, "/logout", "POST", {}, a.cookie, a.csrf)).status,
      200,
    );
    assert.deepEqual(
      (await call(env, "/session", "GET", undefined, a.cookie)).data,
      { authenticated: false },
    );
    assert.equal(
      (await call(env, "/session", "GET", undefined, aSecondTab.cookie)).data
        .authenticated,
      true,
    );
    assert.equal(
      (await call(env, "/session", "GET", undefined, b.cookie)).data
        .authenticated,
      true,
    );
    stub.users.delete("jwt-a@example.test");
    const expiredUpstream = await call(
      env,
      "/snapshot",
      "GET",
      undefined,
      aSecondTab.cookie,
    );
    assert.equal(expiredUpstream.status, 401);
    assert.equal(expiredUpstream.data.code, "AUTH_EXPIRED");
    env.DB.sqlite.exec("UPDATE sessions SET expires_at=0");
    assert.deepEqual(
      (await call(env, "/session", "GET", undefined, b.cookie)).data,
      { authenticated: false },
    );
    env.DB.sqlite.close();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("pending recovery waits and verifies the app state", async () => {
  const stub = upstream();
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  const db = database();
  const env = {
    DB: db,
    APP_ORIGIN: origin,
    YPT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ASSETS: { fetch: () => new Response("page") },
  };
  try {
    const login = await call(env, "/login", "POST", {
      email: "recovery@example.test",
      password: "correct",
    });
    assert.equal(login.status, 200);
    const account = db.sqlite.prepare("SELECT id FROM accounts").get().id;
    const update = db.sqlite.prepare(
      "UPDATE timers SET state='starting', updated_at=? WHERE account_id=?",
    );
    update.run(Date.now(), account);
    const recent = await call(
      env, "/timer/resolve", "POST", { confirmedStopped: true },
      login.cookie, login.data.csrf,
    );
    assert.equal(recent.status, 409);
    assert.equal(recent.data.code, "IN_PROGRESS");
    update.run(Date.now() - PENDING_RECOVERY_MS - 1_000, account);
    const app = stub.users.get("jwt-recovery@example.test");
    app.active = true;
    app.subject = "수학";
    app.startedAt = Date.now() - 1_000;
    const active = await call(
      env, "/timer/resolve", "POST", { confirmedStopped: true },
      login.cookie, login.data.csrf,
    );
    assert.equal(active.status, 409);
    assert.equal(active.data.code, "APP_ACTIVE");
    stub.hideNextStartTime();
    const unverified = await call(
      env, "/timer/resolve", "POST", { confirmedStopped: true },
      login.cookie, login.data.csrf,
    );
    assert.equal(unverified.status, 503);
    assert.equal(unverified.data.code, "REMOTE_UNVERIFIED");
    app.active = false;
    const recovered = await call(
      env, "/timer/resolve", "POST", { confirmedStopped: true },
      login.cookie, login.data.csrf,
    );
    assert.equal(recovered.status, 200);
    assert.equal(recovered.data.timer.state, "idle");
  } finally {
    db.sqlite.close();
    globalThis.fetch = realFetch;
  }
});
