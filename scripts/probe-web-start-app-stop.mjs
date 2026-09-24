import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";

let muted = false;
const output = new Writable({
  write(chunk, encoding, done) {
    if (!muted) process.stdout.write(chunk, encoding);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: true });
const ask = (message) => rl.question(message);
const directory = new URL("../.ypt-local/", import.meta.url);
const file = new URL(`reverse-${Date.now()}.json`, directory);
const report = {
  version: 1,
  startedAt: new Date().toISOString(),
  stage: "input",
  appStopConfirmed: true,
  requests: [],
};
let jwt;
const save = async () => {
  await mkdir(directory, { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
};
async function api(path, method = "GET", body) {
  let response, data;
  try {
    response = await fetch(`https://pi.tgclab.com${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Dart/3.11 (dart:io)",
        ...(jwt ? { Authorization: `JWT ${jwt}` } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    data = await response.json();
  } catch {
    throw new Error("NETWORK_OR_RESPONSE_UNKNOWN");
  }
  report.requests.push({
    endpoint: path.split("?")[0],
    status: response.status,
    success: data?.s === true,
  });
  if (!response.ok || data?.s !== true)
    throw new Error(path === "/user/sign-in-jwt" ? "LOGIN_REJECTED" : "API_REJECTED");
  return data;
}
const reloadBody = {
  pv: 0,
  cd: { su: null, sbu: null, cu: null, eu: null, du: null, tu: null },
};
async function reload() {
  return api("/user/v2/reload/info", "POST", reloadBody);
}
try {
  console.log(
    "Reverse test: this tool starts ONE timer, then you stop it in the phone app.",
  );
  console.log(
    "If interrupted after start, check and stop the timer in the app before anything else.",
  );
  const email = (await ask("YPT email: ")).trim();
  process.stdout.write("YPT password (hidden): ");
  muted = true;
  let password = await ask("");
  muted = false;
  process.stdout.write("\n");
  report.stage = "login";
  const login = await api("/user/sign-in-jwt", "POST", {
    email,
    password,
    loginProvider: "Email",
    new: true,
    getx: true,
    language: "en",
  });
  password = undefined;
  if (typeof login.jwt !== "string") throw new Error("MISSING_JWT");
  jwt = login.jwt;
  if (
    (
      await ask("STOP any timer in the app. Type IDLE when confirmed: ")
    ).trim() !== "IDLE"
  )
    throw new Error("IDLE_NOT_CONFIRMED");
  const before = await reload();
  if (before?.p?.is !== false || !Number.isFinite(Number(before?.dl?.sm)))
    throw new Error("BASELINE_UNVERIFIED");
  const subjects = Array.isArray(before.ss)
    ? before.ss
        .filter((s) => s?.dl !== true && typeof s.tt === "string")
        .map((s) => s.tt)
    : [];
  const subject = (await ask("Exact existing subject title to start: ")).trim();
  if (!subjects.includes(subject)) throw new Error("SUBJECT_NOT_FOUND");
  if (
    (
      await ask("Type START_WEB to start it once (then stop it in the app): ")
    ).trim() !== "START_WEB"
  )
    throw new Error("START_NOT_CONFIRMED");
  report.stage = "starting";
  report.appStopConfirmed = false;
  report.webStartedAt = Date.now();
  await save();
  await api("/study/start", "POST", {
    subject,
    deviceModel: "SM-S921N",
    taskId: null,
  });
  const active = await reload();
  const activeStartedAt = Date.parse(active?.p?.st);
  report.remoteStartedAt = Number.isFinite(activeStartedAt)
    ? activeStartedAt
    : null;
  if (
    active?.p?.is !== true ||
    active?.p?.sb !== subject ||
    !Number.isFinite(activeStartedAt) ||
    Math.abs(activeStartedAt - report.webStartedAt) > 3000
  )
    throw new Error("WEB_START_NOT_VISIBLE_IN_APP");
  report.stage = "waiting-app-stop";
  await save();
  if (
    (
      await ask(
        "Keep studying at least 10 seconds. STOP in the phone app, then type STOPPED: ",
      )
    ).trim() !== "STOPPED"
  )
    throw new Error("APP_STOP_NOT_CONFIRMED");
  const after = await reload();
  report.appStopConfirmed = after?.p?.is === false;
  report.recordedIncreaseMs = Number(after?.dl?.sm) - Number(before.dl.sm);
  report.passed = report.appStopConfirmed && report.recordedIncreaseMs > 0;
  report.stage = "read-only-extra";
  await save();
  const date = (
    await ask("Past study date for history check (YYYY-MM-DD, Enter to skip): ")
  ).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    try {
      const history = await api(`/logs/day?date=${date}`);
      const day = history?.dl;
      report.history = {
        date,
        success: day?.dt === date && Number.isFinite(Number(day.sm)),
        totalMs: Number.isFinite(Number(day?.sm)) ? Number(day.sm) : null,
        subjectSegments: Array.isArray(day?.ls) ? day.ls.length : null,
      };
    } catch {
      report.history = {
        date,
        success: false,
        error: "API_OR_SCHEMA_UNVERIFIED",
      };
    }
  }
  report.stage = "complete";
  await save();
  console.log(
    `Reverse test ${report.passed ? "PASSED" : "NEEDS APP CHECK"}; history ${report.history?.success ?? "skipped"}. Local sanitized result: ${file.pathname}`,
  );
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  muted = false;
  report.error = error instanceof Error ? error.message : "LOCAL_ERROR";
  await save();
  console.error(
    report.stage === "login"
      ? `Login was rejected (${report.error}). No timer was started. Check the account details and retry when ready.`
      : `Test stopped at ${report.stage}: ${report.error}. Check the app and stop any running timer. No action is retried.`,
  );
  process.exitCode = 1;
} finally {
  jwt = undefined;
  rl.close();
}
