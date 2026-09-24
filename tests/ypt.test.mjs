import test from "node:test";
import assert from "node:assert/strict";
import {
  dayFrom,
  groupsFrom,
  membersFrom,
  remoteFrom,
  subjectsFrom,
  ypt,
  YptError,
} from "../worker/ypt.ts";
import worker, { reconcile } from "../worker/index.ts";

test("app timer requires explicit active flag, timestamp with offset, and subject", () => {
  const startedAt = Date.now() - 12_000;
  const stamp = new Date(startedAt).toISOString();
  assert.deepEqual(remoteFrom({ p: { is: true, st: stamp, sb: "수학" } }), {
    status: "running",
    startedAt,
    subject: "수학",
  });
  assert.deepEqual(remoteFrom({ p: { is: false, st: stamp, sb: "수학" } }), {
    status: "idle",
    startedAt: null,
    subject: null,
  });
  assert.equal(
    remoteFrom({ p: { is: true, st: "2026-09-24 20:00:00", sb: "수학" } })
      .status,
    "unverified",
  );
  assert.equal(remoteFrom({ p: { is: true, st: stamp } }).status, "unverified");
  assert.equal(
    remoteFrom({
      p: {
        is: true,
        st: new Date(Date.now() + 100_000).toISOString(),
        sb: "수학",
      },
    }).status,
    "unverified",
  );
});

test("day totals use completed segment logs and preserve missing per-subject values", () => {
  const day = dayFrom(
    {
      dt: "2026-09-24",
      sm: 31_980,
      ls: [
        { sb: "국어", sm: 12_904 },
        { sb: "국어", sm: 19_076 },
      ],
    },
    [
      { title: "국어", studyMs: 0 },
      { title: "수학", studyMs: 0 },
    ],
  );
  assert.equal(day.totalMs, 31_980);
  assert.deepEqual(day.subjects, [
    { title: "국어", studyMs: 31_980 },
    { title: "수학", studyMs: 0 },
  ]);
  assert.equal(
    dayFrom({ dt: "2026-09-24", sm: 0 }).subjectTimesAvailable,
    false,
  );
  assert.throws(() => dayFrom({ dt: "2026-09-24", sm: "bad" }), YptError);
});

test("group arrays deduplicate and members keep unverified status distinct", () => {
  assert.throws(() => groupsFrom({}), YptError);
  assert.throws(() => subjectsFrom({}), YptError);
  assert.deepEqual(
    groupsFrom({
      gs: [{ id: 3, t: "A", mc: 2 }],
      ms: [
        { id: 3, t: "A" },
        { id: 5, t: "B" },
      ],
    }),
    [
      { id: 3, title: "A", memberCount: 2 },
      { id: 5, title: "B", memberCount: null },
    ],
  );
  assert.deepEqual(
    membersFrom({
      ms: [
        { ud: 1, n: "멤버", im: true, dl: { sm: 1000 } },
        { ud: 2, n: "다른 멤버" },
      ],
    }),
    [
      { id: 1, nickname: "멤버", studying: true, studyMs: 1000 },
      { id: 2, nickname: "다른 멤버", studying: null, studyMs: null },
    ],
  );
});

test("upstream success requires s:true and never exposes upstream response in errors", async () => {
  await assert.rejects(
    ypt(
      "/logs/day?date=2026-09-24",
      "GET",
      undefined,
      "secret",
      async () =>
        new Response(JSON.stringify({ s: false, c: 108, private: "secret" }), {
          status: 200,
        }),
    ),
    (error) =>
      error instanceof YptError &&
      error.code === "REJECTED" &&
      !String(error).includes("secret"),
  );
});

test("session endpoint is anonymous without a cookie; mutation rejects untrusted origin", async () => {
  const env = {
    APP_ORIGIN: "https://study.example",
    ASSETS: { fetch: () => new Response("asset") },
  };
  const session = await worker.fetch(
    new Request("https://study.example/api/session"),
    env,
  );
  assert.deepEqual(await session.json(), { authenticated: false });
  const login = await worker.fetch(
    new Request("https://study.example/api/login", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "x@y.z", password: "secret" }),
    }),
    env,
  );
  assert.equal(login.status, 403);
});

test("server state adopts app start, clears app stop, and quarantines mismatched starts", async () => {
  let row = {
    state: "idle",
    subject: null,
    started_at: null,
    origin: null,
    revision: 0,
    pending_id: null,
    updated_at: 0,
  };
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) {
          values = args;
          return this;
        },
        async first() {
          assert.match(sql, /^SELECT state/);
          return { ...row };
        },
        async run() {
          if (sql.startsWith("UPDATE timers SET state='uncertain'")) {
            row = { ...row, state: "uncertain", revision: row.revision + 1 };
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE timers SET state='idle'")) {
            row = {
              ...row,
              state: "idle",
              subject: null,
              started_at: null,
              origin: null,
              revision: row.revision + 1,
            };
            return { meta: { changes: 1 } };
          }
          if (sql.includes("state='running'")) {
            if (row.revision !== values[4] || row.state !== values[5])
              return { meta: { changes: 0 } };
            row = {
              ...row,
              state: "running",
              subject: values[0],
              started_at: values[1],
              origin: "app",
              revision: row.revision + 1,
            };
            return { meta: { changes: 1 } };
          }
          throw new Error("unexpected query");
        },
      };
    },
  };
  const env = { DB: db };
  const startedAt = Date.now() - 1000;
  row = await reconcile(env, "account", {
    status: "running",
    startedAt,
    subject: "수학",
  });
  assert.equal(row.origin, "app");
  assert.equal(row.started_at, startedAt);
  row = await reconcile(env, "account", {
    status: "running",
    startedAt: startedAt + 1000,
    subject: "수학",
  });
  assert.equal(row.state, "uncertain");
  row = { ...row, state: "running" };
  row = await reconcile(env, "account", {
    status: "idle",
    startedAt: null,
    subject: null,
  });
  assert.equal(row.state, "idle");
  assert.equal(row.started_at, null);
});
