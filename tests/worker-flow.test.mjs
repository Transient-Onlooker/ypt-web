import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import worker from "../worker/index.ts";

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
  let hideActiveStartTimeOnce = false;
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
      state.startedAt = Date.now() + nextStartOffsetMs;
      nextStartOffsetMs = 0;
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
          { ud: 1, n: "멤버1", im: true, dl: { sm: 1000 } },
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
    hideNextStartTime() {
      hideActiveStartTimeOnce = true;
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
      { id: 7, title: "공부방", memberCount: 4 },
    ]);
    const groupMembers = await call(
      env, "/groups/7/members", "GET", undefined, a.cookie,
    );
    assert.equal(groupMembers.status, 200);
    assert.equal(groupMembers.data.members.length, 4);
    assert.equal(groupMembers.data.members[0].studying, true);
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
