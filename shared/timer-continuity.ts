export const TIMER_CONTINUITY_WINDOW_MS = 15_000;

export type TimerContinuity = {
  subject: string;
  baseElapsedMs: number;
  canonicalStartedAt: number;
  activeStartedAt: number | null;
  pausedAt: number | null;
};

export function parseTimerContinuity(raw: string | null): TimerContinuity | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const timer = value as TimerContinuity;
    if (typeof timer.subject !== "string" || timer.subject.length < 1 || timer.subject.length > 200 ||
      !Number.isSafeInteger(timer.baseElapsedMs) || timer.baseElapsedMs < 0 || timer.baseElapsedMs > 365 * 86_400_000 ||
      !Number.isSafeInteger(timer.canonicalStartedAt) || timer.canonicalStartedAt <= 0 ||
      (timer.activeStartedAt !== null && (!Number.isSafeInteger(timer.activeStartedAt) || timer.activeStartedAt <= 0)) ||
      (timer.pausedAt !== null && (!Number.isSafeInteger(timer.pausedAt) || timer.pausedAt <= 0)) ||
      (timer.pausedAt === null) !== (timer.activeStartedAt !== null)) return null;
    return timer;
  } catch {
    return null;
  }
}

export function startTimerContinuity(subject: string, startedAt: number): TimerContinuity {
  return { subject, baseElapsedMs: 0, canonicalStartedAt: startedAt, activeStartedAt: startedAt, pausedAt: null };
}

export function pauseTimerContinuity(current: TimerContinuity | null, subject: string,
  startedAt: number, elapsedAt: number, pausedAt: number): TimerContinuity {
  const matching = current?.subject === subject && current.activeStartedAt === startedAt && current.pausedAt === null;
  const canonicalStartedAt = matching ? current.canonicalStartedAt : startedAt;
  const baseElapsedMs = matching
    ? startedAt === canonicalStartedAt
      ? Math.max(0, elapsedAt - canonicalStartedAt)
      : current.baseElapsedMs + Math.max(0, elapsedAt - startedAt)
    : Math.max(0, elapsedAt - startedAt);
  return { subject, baseElapsedMs, canonicalStartedAt, activeStartedAt: null, pausedAt };
}

export function resumeTimerContinuity(current: TimerContinuity | null, subject: string,
  startedAt: number, resumedAt: number): TimerContinuity {
  const withinWindow = current?.subject === subject && current.activeStartedAt === null &&
    current.pausedAt !== null && resumedAt >= current.pausedAt &&
    resumedAt - current.pausedAt <= TIMER_CONTINUITY_WINDOW_MS;
  return {
    subject,
    baseElapsedMs: withinWindow ? current.baseElapsedMs : 0,
    canonicalStartedAt: withinWindow ? current.canonicalStartedAt : startedAt,
    activeStartedAt: startedAt,
    pausedAt: null,
  };
}

export function timerContinuityElapsed(current: TimerContinuity | null, subject: string,
  startedAt: number, now: number): number | null {
  if (!current || current.subject !== subject || current.activeStartedAt !== startedAt || current.pausedAt !== null)
    return null;
  return startedAt === current.canonicalStartedAt
    ? Math.max(0, now - current.canonicalStartedAt)
    : current.baseElapsedMs + Math.max(0, now - startedAt);
}
