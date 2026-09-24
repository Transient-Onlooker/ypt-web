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
const file = new URL(`history-${Date.now()}.json`, directory);
const report = { version: 1, startedAt: new Date().toISOString(), stage: "login", requests: [] };
let jwt;
async function save() {
  await mkdir(directory, { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
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
  report.requests.push({ endpoint: path.split("?")[0], status: response.status, success: data?.s === true });
  if (!response.ok || data?.s !== true)
    throw new Error(path === "/user/sign-in-jwt" ? "LOGIN_REJECTED" : "API_REJECTED");
  return data;
}
try {
  console.log("Read-only YPT history check. This tool does not start or stop a timer.");
  const email = (await ask("YPT email: ")).trim();
  process.stdout.write("YPT password (hidden): ");
  muted = true;
  let password = await ask("");
  muted = false;
  process.stdout.write("\n");
  const login = await api("/user/sign-in-jwt", "POST", {
    email, password, loginProvider: "Email", new: true, getx: true, language: "en",
  });
  password = undefined;
  if (typeof login.jwt !== "string" || !login.jwt) throw new Error("MISSING_JWT");
  jwt = login.jwt;
  report.stage = "history";
  const input = (await ask("Past study date (Enter for 2026-09-23): ")).trim();
  const date = input || "2026-09-23";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) throw new Error("INVALID_DATE");
  report.requestedDate = date;
  const reply = await api(`/logs/day?date=${date}`);
  const log = reply?.dl;
  const segments = Array.isArray(log?.ls) ? log.ls : null;
  report.history = {
    date: typeof log?.dt === "string" ? log.dt : null,
    totalMs: typeof log?.sm === "number" ? log.sm : null,
    rootFields: Object.keys(reply).filter(k => /^[a-z]{1,5}$/.test(k)),
    dayFields: log && typeof log === "object" && !Array.isArray(log) ? Object.keys(log).filter(k => /^[a-z]{1,5}$/.test(k)) : [],
    subjectSegments: segments?.length ?? null,
    subjectTotalMs: segments?.every(s => typeof s?.sm === "number") ? segments.reduce((sum, s) => sum + s.sm, 0) : null,
    segmentFields: segments?.length && typeof segments[0] === "object" ? Object.keys(segments[0]).filter(k => /^[a-z]{1,5}$/.test(k)) : [],
  };
  report.passed = report.history.date === date && Number.isFinite(report.history.totalMs);
  report.stage = "complete";
  await save();
  console.log(`History ${report.passed ? "PASSED" : "SCHEMA_UNVERIFIED"}. Sanitized result: ${file.pathname}`);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  muted = false;
  report.error = error instanceof Error ? error.message : "LOCAL_ERROR";
  await save();
  console.error(`History check stopped at ${report.stage}: ${report.error}. No timer was changed.`);
  process.exitCode = 1;
} finally {
  jwt = undefined;
  rl.close();
}
