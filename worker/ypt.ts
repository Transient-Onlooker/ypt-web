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
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(`${BASE}${path}`, {
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
  } catch {
    throw new YptError("UNCERTAIN");
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new YptError("UNCERTAIN");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new YptError("INVALID_DATA");
  const reply = data as Record<string, unknown>;
  if ([401, 403].includes(response.status) || String(reply.c) === "112")
    throw new YptError("AUTH_EXPIRED");
  if (!response.ok) throw new YptError("UNCERTAIN");
  if (reply.s !== true) throw new YptError("REJECTED");
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
export function subjectsFrom(info: Record<string, unknown>): Subject[] {
  if (!Array.isArray(info.ss)) throw new YptError("INVALID_DATA");
  return array(info.ss)
    .filter((v) => v.dl !== true)
    .map((v) => ({ title: title(v), studyMs: number(v.sm) }))
    .filter((v): v is Subject => !!v.title);
}
export function dayFrom(value: unknown, subjects: Subject[] = []): Day {
  const log = object(value);
  if (
    !log ||
    typeof log.dt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(log.dt) ||
    number(log.sm) === null
  )
    throw new YptError("INVALID_DATA");
  const times = new Map<string, number>();
  for (const entry of array(log.ls)) {
    const name = typeof entry.sb === "string" ? entry.sb : title(entry);
    const ms = number(entry.sm);
    if (name && ms !== null) times.set(name, (times.get(name) ?? 0) + ms);
  }
  // The API's subject sm field can be stale. The day log ls is the only
  // verified per-subject total in the previous live probe.
  const names = [
    ...new Set([...subjects.map((s) => s.title), ...times.keys()]),
  ];
  return {
    date: log.dt,
    totalMs: number(log.sm)!,
    subjects: names.map((name) => ({
      title: name,
      studyMs: times.has(name)
        ? times.get(name)!
        : Array.isArray(log.ls)
          ? 0
          : null,
    })),
    subjectTimesAvailable: Array.isArray(log.ls),
  };
}
export function groupsFrom(reply: Record<string, unknown>): Group[] {
  if (!["gs", "ms", "cs", "ps"].some((key) => Array.isArray(reply[key])))
    throw new YptError("INVALID_DATA");
  const seen = new Set<number>();
  return ["gs", "ms", "cs", "ps"]
    .flatMap((key) => array(reply[key]))
    .map((g) => ({
      id: number(g.id),
      title: typeof g.t === "string" ? g.t : "",
      memberCount: number(g.mc),
    }))
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
  return array(reply.ms)
    .map((m) => ({
      id: number(m.ud),
      nickname: typeof m.n === "string" ? m.n : "",
      studying: typeof m.im === "boolean" ? m.im : null,
      studyMs: number(object(m.dl)?.sm),
    }))
    .filter(
      (m): m is Member =>
        m.id !== null && Number.isSafeInteger(m.id) && !!m.nickname,
    );
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
  if (typeof reply.jwt !== "string" || !reply.jwt)
    throw new YptError("INVALID_DATA");
  return reply.jwt;
}
export async function reload(jwt: string) {
  return ypt("/user/v2/reload/info", "POST", RELOAD_BODY, jwt);
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
