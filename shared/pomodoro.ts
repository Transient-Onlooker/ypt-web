export type Pomodoro = {
  phase: "focus" | "break";
  status: "idle" | "running" | "paused" | "transition" | "halted";
  remainingMs: number;
  endsAt: number | null;
  rounds: number;
};

export function freshPomodoro(focusMinutes = 25): Pomodoro {
  return { phase: "focus", status: "idle", remainingMs: focusMinutes * 60_000, endsAt: null, rounds: 0 };
}

export function pomodoroRemaining(timer: Pomodoro, now: number): number {
  return Math.max(0, timer.endsAt === null ? timer.remainingMs : timer.endsAt - now);
}

export function shouldAdvancePomodoro(timer: Pomodoro, now: number, visible: boolean,
  snapshotCheckedAt: number | null, lastVisibleAt: number): boolean {
  return timer.status === "running" && timer.endsAt !== null && now >= timer.endsAt &&
    visible && snapshotCheckedAt !== null && snapshotCheckedAt >= lastVisibleAt &&
    now - snapshotCheckedAt <= 45_000;
}

export function runPomodoro(timer: Pomodoro, now: number): Pomodoro {
  return { ...timer, status: "running", endsAt: now + timer.remainingMs };
}

export function pausePomodoro(timer: Pomodoro, now: number): Pomodoro {
  return { ...timer, status: "paused", remainingMs: pomodoroRemaining(timer, now), endsAt: null };
}

export function nextPomodoro(timer: Pomodoro, now: number, focusMinutes: number, breakMinutes: number): Pomodoro {
  const focus = timer.phase === "break";
  const remainingMs = (focus ? focusMinutes : breakMinutes) * 60_000;
  return {
    phase: focus ? "focus" : "break",
    status: "running",
    remainingMs,
    endsAt: now + remainingMs,
    rounds: timer.rounds + (focus ? 0 : 1),
  };
}

export function parsePomodoro(raw: string | null): Pomodoro {
  if (!raw) return freshPomodoro();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return freshPomodoro();
    const timer = value as Pomodoro;
    if ((timer.phase !== "focus" && timer.phase !== "break") ||
      !["idle", "running", "paused", "transition", "halted"].includes(timer.status) ||
      !Number.isFinite(timer.remainingMs) || timer.remainingMs < 0 || timer.remainingMs > 180 * 60_000 ||
      (timer.endsAt !== null && (!Number.isFinite(timer.endsAt) || timer.endsAt < 0 ||
        timer.endsAt > Date.now() + 180 * 60_000)) ||
      !Number.isInteger(timer.rounds) || timer.rounds < 0) return freshPomodoro();
    if (timer.status === "running" && timer.endsAt === null) return freshPomodoro();
    if (timer.status !== "running" && timer.endsAt !== null) return freshPomodoro();
    return timer.status === "transition" ? { ...timer, status: "halted" } : timer;
  } catch {
    return freshPomodoro();
  }
}
