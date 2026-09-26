export type PlanItem = {
  id: string;
  text: string;
  estimateMinutes: number;
  done: boolean;
};

export type IntervalPhase = "focus" | "short" | "long";
export type IntervalSettings = Record<IntervalPhase, number>;
export type IntervalTimer = {
  phase: IntervalPhase;
  remainingMs: number;
  endsAt: number | null;
  completed: boolean;
};

export const PLAN_ESTIMATES = [15, 25, 30, 45, 60, 90, 120] as const;
export const INTERVAL_MINUTES: IntervalSettings = {
  focus: 25,
  short: 5,
  long: 15,
};

export function freshInterval(phase: IntervalPhase = "focus", minutes = INTERVAL_MINUTES[phase]): IntervalTimer {
  return { phase, remainingMs: minutes * 60_000, endsAt: null, completed: false };
}

export function parseIntervalSettings(raw: string | null): IntervalSettings {
  if (!raw) return { ...INTERVAL_MINUTES };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return { ...INTERVAL_MINUTES };
    const settings = value as IntervalSettings;
    if (!Number.isInteger(settings.focus) || settings.focus < 5 || settings.focus > 180 ||
      !Number.isInteger(settings.short) || settings.short < 1 || settings.short > 60 ||
      !Number.isInteger(settings.long) || settings.long < 1 || settings.long > 60)
      return { ...INTERVAL_MINUTES };
    return { focus: settings.focus, short: settings.short, long: settings.long };
  } catch {
    return { ...INTERVAL_MINUTES };
  }
}

export function intervalRemaining(timer: IntervalTimer, now: number): number {
  return Math.max(0, timer.endsAt === null ? timer.remainingMs : timer.endsAt - now);
}

export function parsePlan(raw: string | null): PlanItem[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 12) return [];
    if (!value.every((item) => item && typeof item === "object" &&
      typeof item.id === "string" && item.id.length <= 80 &&
      typeof item.text === "string" && item.text.length > 0 && item.text.length <= 80 &&
      PLAN_ESTIMATES.some((minutes) => minutes === item.estimateMinutes) &&
      typeof item.done === "boolean")) return [];
    const ids = new Set(value.map((item: PlanItem) => item.id));
    return ids.size === value.length ? value as PlanItem[] : [];
  } catch {
    return [];
  }
}

export function previousCalendarDate(date: string): string {
  const timestamp = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(timestamp)
    ? new Date(timestamp - 86_400_000).toISOString().slice(0, 10) : "";
}

export function eligibleCarryOver(current: PlanItem[], previous: PlanItem[]): PlanItem[] {
  const seen = new Set(current.map((item) => item.text.trim().toLocaleLowerCase("ko-KR")));
  const eligible: PlanItem[] = [];
  for (const item of previous) {
    if (current.length + eligible.length >= 12) break;
    if (item.done) continue;
    const key = item.text.trim().toLocaleLowerCase("ko-KR");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    eligible.push(item);
  }
  return eligible;
}

export function parseInterval(raw: string | null): IntervalTimer {
  if (!raw) return freshInterval();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return freshInterval();
    const timer = value as IntervalTimer;
    if (!(["focus", "short", "long"] as unknown[]).includes(timer.phase) ||
      !Number.isFinite(timer.remainingMs) || timer.remainingMs < 0 ||
      timer.remainingMs > 180 * 60_000 ||
      (timer.endsAt !== null && (!Number.isFinite(timer.endsAt) ||
        timer.endsAt < 0 || timer.endsAt > Date.now() + 180 * 60_000)) ||
      typeof timer.completed !== "boolean") return freshInterval();
    return timer;
  } catch {
    return freshInterval();
  }
}
