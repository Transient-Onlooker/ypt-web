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
const file = new URL(`groups-${Date.now()}.json`, directory);
const report = { version: 1, startedAt: new Date().toISOString(), stage: "login", requests: [], groups: [] };
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
const reloadBody = { pv: 0, cd: { su: null, sbu: null, cu: null, eu: null, du: null, tu: null } };
function format(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`;
}
function studyMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value);
  return null;
}
try {
  console.log("Read-only group check. This tool never changes groups or timers.");
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
  report.stage = "groups";
  const info = await api("/user/v2/reload/info", "POST", reloadBody);
  const countryId = Number(info.coid);
  if (!Number.isSafeInteger(countryId) || countryId < 0) throw new Error("COUNTRY_ID_UNVERIFIED");
  const list = await api("/group/groups/v2");
  const joined = [];
  const seen = new Set();
  for (const key of ["gs", "ms", "cs", "ps"]) {
    if (!Array.isArray(list[key])) throw new Error("GROUP_LIST_SCHEMA_UNVERIFIED");
    for (const group of list[key]) {
      const id = Number(group?.id);
      if (Number.isSafeInteger(id) && id > 0 && typeof group.t === "string" && group.t && !seen.has(id)) {
        seen.add(id);
        joined.push(group);
      }
    }
  }
  report.joinedGroupCount = joined.length;
  if (!joined.length) throw new Error("NO_JOINED_GROUPS_VISIBLE");
  for (const [index, group] of joined.slice(0, 10).entries()) {
    const id = Number(group.id);
    const result = await api(`/logs/group/members/v2?groupID=${id}&countryID=${countryId}&isLooking=true&version=810046`);
    if (!Array.isArray(result.ms)) throw new Error("MEMBER_SCHEMA_UNVERIFIED");
    const members = result.ms;
    const valid = members.every(m => typeof m?.n === "string" && typeof m?.im === "boolean" && studyMs(m?.dl?.sm) !== null);
    report.groups.push({ group: index + 1, memberCount: members.length, studyingCount: members.filter(m => m.im === true).length, totalStudyMs: members.reduce((sum, m) => sum + (studyMs(m?.dl?.sm) ?? 0), 0), memberFields: members.length && typeof members[0] === "object" ? Object.keys(members[0]).filter(k => /^[a-z]{1,5}$/.test(k)) : [], valid });
    console.log(`Group ${index + 1}: ${group.t}; ${members.length} members.`);
    for (const member of members.slice(0, 30)) console.log(`  ${member.n ?? "(unknown)"}: ${member.im === true ? "studying" : member.im === false ? "resting" : "unknown"}, ${studyMs(member?.dl?.sm) !== null ? format(studyMs(member.dl.sm)) : "time unknown"}`);
    if (members.length > 30) console.log(`  ... ${members.length - 30} more members omitted from terminal output.`);
  }
  const comparison = (await ask("Do member statuses and times match the phone app? (yes/no/unchecked): ")).trim().toLowerCase();
  report.appComparison = ["yes", "no", "unchecked"].includes(comparison) ? comparison : "unchecked";
  report.passed = report.groups.length > 0 && report.groups.every(g => g.valid);
  report.stage = "complete";
  await save();
  console.log(`Group API ${report.passed ? "PASSED" : "SCHEMA_UNVERIFIED"}; app comparison ${report.appComparison}. Sanitized result: ${file.pathname}`);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  muted = false;
  report.error = error instanceof Error ? error.message : "LOCAL_ERROR";
  await save();
  console.error(`Group check stopped at ${report.stage}: ${report.error}. No group or timer was changed.`);
  process.exitCode = 1;
} finally {
  jwt = undefined;
  rl.close();
}
