import type { Day } from "./types.ts";

export function duration(ms: number | null | undefined) {
  if (ms == null) return "확인 중";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatDaySummary(day: Day) {
  const lines = [`YPT Web · 오늘의 공부 (${day.date})`, `완료 기록 ${duration(day.totalMs)}`];
  if (!day.subjectTimesAvailable) {
    lines.push("과목별 시간 미확인");
  } else {
    const subjects = [...day.subjects]
      .filter((subject) => subject.studyMs !== null && subject.studyMs > 0)
      .sort((a, b) => (b.studyMs ?? 0) - (a.studyMs ?? 0) ||
        a.title.localeCompare(b.title, "ko-KR"));
    if (!subjects.length) lines.push("완료된 과목 기록 없음");
    else subjects.forEach((subject) =>
      lines.push(`${subject.title.replace(/\s+/g, " ").trim()} ${duration(subject.studyMs)}`));
  }
  return lines.join("\n");
}
