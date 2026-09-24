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
const file = new URL(`cross-stop-${Date.now()}.json`, directory);
const report = {
  version: 1,
  startedAt: new Date().toISOString(),
  stage: "input",
  stopConfirmed: true,
  requests: [],
};
let jwt;
const save = async () => {
  await mkdir(directory, { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
};
async function api(path, body) {
  let response, data;
  try {
    response = await fetch(`https://pi.tgclab.com${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Dart/3.11 (dart:io)",
        ...(jwt ? { Authorization: `JWT ${jwt}` } : {}),
      },
      body: JSON.stringify(body),
    });
    data = await response.json();
  } catch {
    throw new Error("NETWORK_OR_RESPONSE_UNKNOWN");
  }
  report.requests.push({
    endpoint: path,
    status: response.status,
    success: data?.s === true,
  });
  if (!response.ok || data?.s !== true) throw new Error("API_REJECTED");
  return data;
}
const reloadBody = {
  pv: 0,
  cd: { su: null, sbu: null, cu: null, eu: null, du: null, tu: null },
};
async function reload() {
  return api("/user/v2/reload/info", reloadBody);
}
function active(info, windowStart, windowEnd) {
  const p = info?.p;
  if (
    p?.is !== true ||
    typeof p?.sb !== "string" ||
    !p.sb ||
    typeof p.st !== "string"
  )
    throw new Error("ACTIVE_STATE_UNVERIFIED");
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(p.st))
    throw new Error("START_TIME_HAS_NO_OFFSET");
  const startedAt = Date.parse(p.st);
  if (
    !Number.isSafeInteger(startedAt) ||
    startedAt < windowStart ||
    startedAt > windowEnd
  )
    throw new Error("START_TIME_OUTSIDE_APP_WINDOW");
  return { startedAt, subject: p.sb };
}
try {
  console.log(
    "Cross-control test: start in YPT app, then this tool sends ONE web stop using the exact API start time.",
  );
  console.log(
    "The app records real study time. If any step fails, check and stop the timer in the app.",
  );
  const email = (await ask("YPT email: ")).trim();
  process.stdout.write("YPT password (hidden): ");
  muted = true;
  let password = await ask("");
  muted = false;
  process.stdout.write("\n");
  const login = await api("/user/sign-in-jwt", {
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
  const idle = await reload();
  if (idle?.p?.is !== false) throw new Error("IDLE_STATE_UNVERIFIED");
  const baseline = Number(idle?.dl?.sm);
  if (!Number.isFinite(baseline)) throw new Error("DAY_LOG_UNVERIFIED");
  const startWindow = Date.now();
  if (
    (
      await ask(
        "START a subject in the phone app. Type RUNNING while it runs: ",
      )
    ).trim() !== "RUNNING"
  )
    throw new Error("RUNNING_NOT_CONFIRMED");
  const firstAt = Date.now();
  const first = active(await reload(), startWindow, firstAt);
  report.stage = "observed-running";
  report.appStartedAt = first.startedAt;
  await save();
  console.log("Exact app start time observed. Keep the app timer running.");
  if (
    (
      await ask(
        "After at least 10 seconds, type STOP_WEB to send one web stop: ",
      )
    ).trim() !== "STOP_WEB"
  )
    throw new Error("STOP_NOT_CONFIRMED");
  const secondAt = Date.now();
  const second = active(await reload(), startWindow, secondAt);
  if (first.startedAt !== second.startedAt || first.subject !== second.subject)
    throw new Error("ACTIVE_STATE_CHANGED");
  report.stage = "stopping";
  report.stopConfirmed = false;
  await save();
  const stopped = await api("/study/stop", {
    startedAt: first.startedAt,
    deviceModel: "SM-S921N",
  });
  const observed = await reload();
  report.stopConfirmed = observed?.p?.is === false;
  report.stage = "complete";
  report.recordedIncreaseMs = Number(observed?.dl?.sm) - baseline;
  report.stopResponseStudyMs = Number(stopped?.dl?.sm);
  report.expectedStudyMs = secondAt - first.startedAt;
  report.passed =
    report.stopConfirmed &&
    report.recordedIncreaseMs > 0 &&
    Math.abs(report.recordedIncreaseMs - report.expectedStudyMs) < 3000;
  await save();
  console.log(
    `Cross-control ${report.passed ? "PASSED" : "NEEDS APP CHECK"}. Local sanitized result: ${file.pathname}`,
  );
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  muted = false;
  report.error = error instanceof Error ? error.message : "LOCAL_ERROR";
  await save();
  console.error(
    `Test stopped at ${report.stage}: ${report.error}. Check the app and stop any running timer. No stop is retried.`,
  );
  process.exitCode = 1;
} finally {
  jwt = undefined;
  rl.close();
}
