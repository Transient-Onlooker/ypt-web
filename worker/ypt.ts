import type { Day, Group, Member, Subject } from "../shared/types.ts";

const BASE = "https://pi.tgclab.com";
const DEVICE = "SM-S921N";
export const RELOAD_BODY = {
  pv: 0,
  cd: { su: null, sbu: null, cu: null, eu: null, du: null, tu: null },
};

export class YptError extends Error {
  code: "REJECTED" | "AUTH_EXPIRED" | "UNCERTAIN" | "INVALID_DATA";
  constructor(
    code: "REJECTED" | "AUTH_EXPIRED" | "UNCERTAIN" | "INVALID_DATA",
  ) {
    super(code);
    this.code = code;
  }
}

export async function ypt(
  path: string,
  method: "GET" | "POST",
  body?: object,
  jwt?: string,
  fetcher: typeof fetch = fetch,
  onClockOffset?: (offsetMs: number | null) => void,
): Promise<Record<string, unknown>> {
  const route = path.split("?")[0];
  let response: Response;
  const requestAt = Date.now();
  try {
    response = await fetcher(`${BASE}${path}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Dart/3.11 (dart:io)",
        ...(jwt ? { Authorization: `JWT ${jwt}` } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch (error) {
    console.warn("YPT fetch failed", route, error instanceof Error ? error.name : "unknown");
    throw new YptError("UNCERTAIN");
  }
  const responseAt = Date.now();
  // Do not forward login credentials or JWTs to a redirect target.
  if (response.status >= 300 && response.status < 400) {
    console.warn("YPT redirect rejected", route, response.status);
    throw new YptError("UNCERTAIN");
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    console.warn(
      "YPT non-JSON response",
      route,
      response.status,
      response.headers.get("content-type"),
    );
    throw new YptError("UNCERTAIN");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    console.warn("YPT invalid response shape", route, response.status);
    throw new YptError("INVALID_DATA");
  }
  const reply = data as Record<string, unknown>;
  if ([401, 403].includes(response.status) || String(reply.c) === "112")
    throw new YptError("AUTH_EXPIRED");
  if (!response.ok) {
    console.warn("YPT HTTP error", route, response.status);
    throw new YptError("UNCERTAIN");
  }
  if (reply.s !== true) {
    console.warn("YPT rejected", route, response.status);
    throw new YptError("REJECTED");
  }
  if (onClockOffset) {
    // HTTP Date has one-second precision. Its midpoint limits display error
    // while the original p.st remains untouched for stop requests.
    const date = Date.parse(response.headers.get("date") ?? "");
    const roundTripMs = responseAt - requestAt;
    const offsetMs = date + 500 - (requestAt + responseAt) / 2;
    onClockOffset(
      Number.isFinite(offsetMs) && roundTripMs >= 0 && roundTripMs < 3_000 &&
        Math.abs(offsetMs) < 60_000
        ? Math.round(offsetMs)
        : null,
    );
  }
  return reply;
}

export function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(object).filter((v): v is Record<string, unknown> => !!v)
    : [];
}
function number(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function title(value: Record<string, unknown>): string | null {
  for (const key of [
    "tt",
    "t",
    "title",
    "subject",
    "subjectName",
    "subjectTitle",
  ])
    if (typeof value[key] === "string" && value[key].trim())
      return value[key].trim() as string;
  return null;
}
function subjectColor(value: Record<string, unknown>): string | null {
  const raw = value.co ?? value.c;
  const parsed = typeof raw === "number"
    ? raw
    : typeof raw === "string" && /^-?\d+$/.test(raw)
      ? Number(raw)
      : NaN;
  if (!Number.isInteger(parsed) || parsed === 0 || parsed < -0x80000000 || parsed > 0xffffffff)
    return null;
  return `#${((parsed >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`;
}
export function subjectsFrom(info: Record<string, unknown>): Subject[] {
  if (!Array.isArray(info.ss)) throw new YptError("INVALID_DATA");
  return array(info.ss)
    .filter((v) => v.dl !== true)
    .map((v) => {
      const color = subjectColor(v);
      return {
        title: title(v), studyMs: number(v.sm),
        ...(color ? { color } : {}),
      };
    })
    .filter((v): v is Subject => !!v.title);
}
export function dayFrom(value: unknown, subjects: Subject[] = []): Day {
  const log = object(value);
  const totalMs = number(log?.sm);
  if (
    !log ||
    typeof log.dt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(log.dt) ||
    !Number.isFinite(Date.parse(`${log.dt}T00:00:00Z`)) ||
    new Date(`${log.dt}T00:00:00Z`).toISOString().slice(0, 10) !== log.dt ||
    totalMs === null
  )
    throw new YptError("INVALID_DATA");
  const times = new Map<string, number>();
  const segments = Array.isArray(log.ls) ? log.ls : null;
  let subjectTimesAvailable = segments !== null &&
    (segments.length > 0 || totalMs === 0);
  let longestSegmentMs: number | null = null;
  for (const raw of segments ?? []) {
    const entry = object(raw);
    const name = entry
      ? typeof entry.sb === "string" && entry.sb.trim()
        ? entry.sb.trim() : title(entry)
      : null;
    const ms = number(entry?.sm);
    if (!name || ms === null || !Number.isSafeInteger(ms)) {
      subjectTimesAvailable = false;
      continue;
    }
    longestSegmentMs = Math.max(longestSegmentMs ?? 0, ms);
    const next = (times.get(name) ?? 0) + ms;
    if (!Number.isSafeInteger(next)) subjectTimesAvailable = false;
    else times.set(name, next);
  }
  if (!subjectTimesAvailable) longestSegmentMs = null;
  // The API's subject sm field can be stale. The day log ls is the only
  // verified per-subject total in the previous live probe.
  const names = [
    ...new Set([...subjects.map((s) => s.title), ...times.keys()]),
  ];
  const colors = new Map(subjects.filter((s) => s.color).map((s) => [s.title, s.color!]));
  return {
    date: log.dt,
    totalMs,
    longestSegmentMs,
    subjects: names.map((name) => ({
      title: name,
      ...(colors.has(name) ? { color: colors.get(name)! } : {}),
      studyMs: subjectTimesAvailable ? (times.get(name) ?? 0) : null,
    })),
    subjectTimesAvailable,
  };
}
export function groupsFrom(reply: Record<string, unknown>): Group[] {
  if (!["gs", "ms", "cs", "ps"].some((key) => Array.isArray(reply[key])))
    throw new YptError("INVALID_DATA");
  const seen = new Set<number>();
  const optionalText = (value: unknown, max: number) =>
    typeof value === "string" && value.trim() && value.length <= max
      ? value.trim() : null;
  return ["gs", "ms", "cs", "ps"]
    .flatMap((key) => array(reply[key]))
    .map((g) => {
      const category = optionalText(g.c, 100);
      const owner = optionalText(g.on, 100);
      const slogan = optionalText(g.sn, 500);
      return {
        id: number(g.id),
        title: typeof g.t === "string" ? g.t : "",
        capacity: number(g.mc),
        ...(category ? { category } : {}),
        ...(owner ? { owner } : {}),
        ...(slogan ? { slogan } : {}),
      };
    })
    .filter(
      (g): g is Group =>
        g.id !== null &&
        Number.isSafeInteger(g.id) &&
        g.id > 0 &&
        !!g.title &&
        !seen.has(g.id) &&
        !!seen.add(g.id),
    );
}
export function membersFrom(reply: Record<string, unknown>): Member[] {
  if (!Array.isArray(reply.ms)) throw new YptError("INVALID_DATA");
  const parsed = array(reply.ms)
    .map((m) => {
      const log = object(m.dl);
      const studying = typeof log?.is === "boolean" ? log.is : null;
      const stamp = log?.st;
      const startedAt = studying === true && typeof stamp === "string" &&
        /(?:Z|[+-]\d{2}:?\d{2})$/.test(stamp) ? Date.parse(stamp) : NaN;
      return {
        id: number(m.ud),
        nickname: typeof m.n === "string" ? m.n.trim() : "",
        // im stayed true for idle members; dl.is matched the observed idle state.
        studying,
        studyMs: number(log?.sm),
        startedAt: Number.isSafeInteger(startedAt) &&
          startedAt >= Date.now() - 24 * 60 * 60_000 &&
          startedAt <= Date.now() + 30_000 ? startedAt : null,
      };
    })
    .filter(
      (m): m is Member =>
        m.id !== null && Number.isSafeInteger(m.id) && !!m.nickname,
    );
  const unique = new Map<number, Member>();
  for (const member of parsed) {
    const prior = unique.get(member.id);
    if (!prior) {
      unique.set(member.id, member);
      continue;
    }
    prior.studying = prior.studying === member.studying ? prior.studying : null;
    prior.studyMs = prior.studyMs === member.studyMs ? prior.studyMs : null;
    prior.startedAt = prior.studying === true && prior.startedAt === member.startedAt
      ? prior.startedAt : null;
  }
  return [...unique.values()];
}
export function remoteFrom(info: Record<string, unknown>): {
  status: "idle" | "running" | "unverified";
  startedAt: number | null;
  subject: string | null;
} {
  const profile = object(info.p);
  if (profile?.is === false)
    return { status: "idle", startedAt: null, subject: null };
  if (
    profile?.is !== true ||
    typeof profile.sb !== "string" ||
    !profile.sb ||
    typeof profile.st !== "string"
  )
    return { status: "unverified", startedAt: null, subject: null };
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(profile.st))
    return { status: "unverified", startedAt: null, subject: null };
  const startedAt = Date.parse(profile.st);
  if (
    !Number.isSafeInteger(startedAt) ||
    startedAt <= 0 ||
    startedAt > Date.now() + 30_000
  )
    return { status: "unverified", startedAt: null, subject: null };
  return { status: "running", startedAt, subject: profile.sb };
}
export async function login(email: string, password: string) {
  const reply = await ypt("/user/sign-in-jwt", "POST", {
    email,
    password,
    loginProvider: "Email",
    new: true,
    getx: true,
    language: "en",
  });
  if (typeof reply.jwt !== "string" || !reply.jwt) {
    console.warn("YPT login missing JWT field");
    throw new YptError("INVALID_DATA");
  }
  return reply.jwt;
}
export async function reload(jwt: string, onClockOffset?: (offsetMs: number | null) => void) {
  return ypt("/user/v2/reload/info", "POST", RELOAD_BODY, jwt, fetch, onClockOffset);
}
export async function start(jwt: string, subject: string) {
  const reply = await ypt(
    "/study/start",
    "POST",
    { subject, deviceModel: DEVICE, taskId: null },
    jwt,
  );
  if (!object(reply.dl)) throw new YptError("UNCERTAIN");
  return reply;
}
export async function stop(jwt: string, startedAt: number) {
  const reply = await ypt(
    "/study/stop",
    "POST",
    { startedAt, deviceModel: DEVICE },
    jwt,
  );
  if (!object(reply.dl)) throw new YptError("UNCERTAIN");
  return reply;
}
export async function history(jwt: string, date: string) {
  const reply = await ypt(`/logs/day?date=${date}`, "GET", undefined, jwt);
  const log = object(reply.dl);
  if (!log || log.dt !== date) throw new YptError("INVALID_DATA");
  return dayFrom(log);
}
export async function groups(jwt: string) {
  return groupsFrom(await ypt("/group/groups/v2", "GET", undefined, jwt));
}
export async function members(jwt: string, groupId: number, countryId: number) {
  const reply = await ypt(
    `/logs/group/members/v2?groupID=${groupId}&countryID=${countryId}&isLooking=true&version=810046`,
    "GET",
    undefined,
    jwt,
  );
  return membersFrom(reply);
}
