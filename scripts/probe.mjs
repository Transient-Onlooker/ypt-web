import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";

// Interactive terminal only. No password/JWT arguments, files, or response dumps.
let muted = false;
const output = new Writable({
  write(chunk, encoding, done) {
    if (!muted) process.stdout.write(chunk, encoding);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: true });
const ask = async (message) => (await rl.question(message)).trim();
let jwt;
const report = {
  version: 1,
  mode: "read-only",
  startedAt: new Date().toISOString(),
  snapshots: [],
  requests: [],
};
const directory = new URL("../.ypt-local/", import.meta.url);
const file = new URL(`discovery-${Date.now()}.json`, directory);
const save = async () => {
  await mkdir(directory, { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
};
const reloadBody = {
  pv: 0,
  cd: { su: null, sbu: null, cu: null, eu: null, du: null, tu: null },
};
async function api(path, body) {
  let response, data;
  try {
    response = await fetch(`https://pi.tgclab.com${path}`, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Dart/3.11 (dart:io)",
        ...(jwt ? { Authorization: `JWT ${jwt}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    data = await response.json();
  } catch {
    throw new Error("NETWORK_OR_RESPONSE_ERROR");
  }
  report.requests.push({
    endpoint: path.split("?")[0],
    status: response.status,
    success: data?.s === true,
  });
  if (!response.ok || data?.s !== true) throw new Error("API_REJECTED");
  return data;
}
function shape(value, depth = 0) {
  if (depth > 8) return "nested";
  if (value === null) return null;
  if (Array.isArray(value))
    return {
      length: value.length,
      sample: value.length ? shape(value[0], depth + 1) : null,
    };
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !/jwt|token|password|email/i.test(k))
        .map(([k, v]) => [k, shape(v, depth + 1)]),
    );
  return typeof value;
}
const aliases = new Map();
function alias(value) {
  if (!aliases.has(value)) aliases.set(value, `subject-${aliases.size + 1}`);
  return aliases.get(value);
}
function timeCandidate(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value))
    return { kind: "number", value };
  if (typeof value !== "string") return { kind: typeof value };
  const trimmed = value.trim();
  if (/^\d{13}$/.test(trimmed))
    return { kind: "epoch-ms", value: Number(trimmed) };
  if (/^\d{10}$/.test(trimmed))
    return { kind: "epoch-s", value: Number(trimmed) };
  if (/^\d{4}-\d{2}-\d{2}[T ][0-9:.+ Z-]+$/.test(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms)
      ? {
          kind: "date",
          epochMs: ms,
          hasOffset: /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed),
        }
      : { kind: "unparsed-date" };
  }
  return { kind: "opaque-string", length: trimmed.length };
}
function profileEvidence(profile) {
  if (!profile || typeof profile !== "object") return null;
  return {
    flags: Object.fromEntries(
      ["is", "ia", "in", "so", "aw", "wo"].map((k) => [
        k,
        typeof profile[k] === "boolean" ? profile[k] : null,
      ]),
    ),
    fields: Object.fromEntries(
      ["st", "sp", "stm", "rt"].map((k) => [k, timeCandidate(profile[k])]),
    ),
    subject:
      typeof profile.sb === "string" && profile.sb ? alias(profile.sb) : null,
  };
}
function safeLog(value, key = "") {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((v) => safeLog(v, key));
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, safeLog(v, k)]),
    );
  if (/^(id|ud|uid|userId|jwt|token|e|email)$/i.test(key)) return "[redacted]";
  if (/^(sb|subject|tt|title|t)$/.test(key) && typeof value === "string")
    return alias(value);
  if (typeof value === "string")
    return key === "dt" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : timeCandidate(value);
  return value;
}
async function snapshot(stage) {
  const before = Date.now();
  const data = await api("/user/v2/reload/info", reloadBody);
  report.snapshots.push({
    stage,
    before,
    after: Date.now(),
    profile: profileEvidence(data.p),
    dayLog: safeLog(data.dl),
    subjects: (data.ss ?? []).map((s) => ({
      title: alias(s.tt ?? s.t ?? ""),
      studyMs: s.sm,
      archived: s.dl,
    })),
  });
  await save();
  console.log(`Saved ${stage} (no profile, password or JWT).`);
  return data;
}
try {
  console.log(
    "YPT read-only discovery. This tool never sends study/start or study/stop.",
  );
  console.log(
    "Use the phone app to start/stop. Study time will be recorded by the app.",
  );
  const email = await ask("YPT email: ");
  process.stdout.write("YPT password (hidden): ");
  muted = true;
  let password = await rl.question("");
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
  await ask("Stop the timer in the app, then press Enter: ");
  const idle = await snapshot("app-idle");
  report.appStartWindow = { after: Date.now() };
  if (
    (await ask(
      "START one subject in the phone app. Type RUNNING only while it is still running: ",
    )) !== "RUNNING"
  )
    throw new Error("APP_NOT_RUNNING");
  report.appStartWindow.before = Date.now();
  await snapshot("app-running-1");
  if (
    (await ask(
      "Keep studying at least 10 seconds. Type RUNNING while it is still running: ",
    )) !== "RUNNING"
  )
    throw new Error("APP_NOT_RUNNING");
  await snapshot("app-running-2");
  await ask("STOP the timer in the phone app, then press Enter: ");
  await snapshot("app-stopped");
  const date = await ask(
    "Past study date to inspect (YYYY-MM-DD, Enter to skip): ",
  );
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    try {
      const day = await api(`/logs/day?date=${date}`);
      report.history = {
        requestedDate: date,
        shape: shape(day),
        dayLog: safeLog(day.dl),
        subjectBooks: (day.sbs ?? []).map((s) => ({
          ...shape(s),
          t: alias(s.t ?? s.tt ?? ""),
        })),
      };
    } catch {
      report.history = { error: "API_OR_SCHEMA_UNVERIFIED" };
    }
  }
  try {
    const groups = await api("/group/groups/v2");
    report.groups = { shape: shape(groups), members: [] };
    const seen = new Set();
    for (const key of ["gs", "ms", "cs", "ps"])
      for (const g of groups[key] ?? []) {
        if (!Number.isSafeInteger(Number(g.id)) || seen.has(g.id)) continue;
        seen.add(g.id);
        const members = await api(
          `/logs/group/members/v2?groupID=${g.id}&countryID=${Number(idle.coid)}&isLooking=true&version=810046`,
        );
        report.groups.members.push({
          shape: shape(members),
          sample: (members.ms ?? [])
            .slice(0, 3)
            .map((m) => ({ im: m.im, dayLog: safeLog(m.dl) })),
        });
      }
  } catch {
    report.groupError = "API_OR_SCHEMA_UNVERIFIED";
  }
  const comparison = await ask(
    "Do the inspected date total and group studying states match the app? (yes/no/unchecked): ",
  );
  report.appComparison = ["yes", "no", "unchecked"].includes(comparison)
    ? comparison
    : "unchecked";
  report.completed = true;
  await save();
  console.log(`Done. Sanitized local evidence: ${file.pathname}`);
} catch {
  muted = false;
  report.error = "DISCOVERY_INCOMPLETE";
  await save();
  console.error(
    "Discovery incomplete. Check the app and stop any timer you started. No requests were retried.",
  );
  process.exitCode = 1;
} finally {
  jwt = undefined;
  rl.close();
}
