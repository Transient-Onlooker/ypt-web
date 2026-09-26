import type { Day } from "./types.ts";

export type TrendDay = { date: string; totalMs: number | null };

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

function csvCell(value: string) {
  const flattened = value.replace(/[\r\n]+/g, " ");
  const safe = /^[\s]*[=+\-@\t]/.test(flattened) ? `'${flattened}` : flattened;
  return `"${safe.replace(/"/g, '""')}"`;
}

function csvRow(values: string[]) {
  return values.map(csvCell).join(",");
}

export function formatDayCsv(day: Day) {
  const rows = [
    ["날짜", "항목", "과목", "시간", "확인 상태"],
    [day.date, "완료 총시간", "", duration(day.totalMs), "확인"],
  ];
  if (!day.subjectTimesAvailable) {
    rows.push([day.date, "과목별 시간", "", "", "미확인"]);
  } else {
    [...day.subjects]
      .sort((a, b) => a.title.localeCompare(b.title, "ko-KR"))
      .forEach((subject) => rows.push([
        day.date, "과목별 시간", subject.title,
        subject.studyMs === null ? "" : duration(subject.studyMs),
        subject.studyMs === null ? "미확인" : "확인",
      ]));
  }
  return rows.map(csvRow).join("\r\n") + "\r\n";
}

export function formatTrendCsv(days: TrendDay[]) {
  const rows = [
    ["날짜", "완료 공부시간", "확인 상태"],
    ...days.map((day) => [day.date,
      day.totalMs === null ? "" : duration(day.totalMs),
      day.totalMs === null ? "미확인" : "확인"]),
  ];
  return rows.map(csvRow).join("\r\n") + "\r\n";
}

export function longestVerifiedStreak(days: TrendDay[]) {
  let longest = 0;
  let current = 0;
  let previousDate: string | null = null;
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    const adjacent = previousDate !== null &&
      Date.parse(`${day.date}T00:00:00Z`) - Date.parse(`${previousDate}T00:00:00Z`) === 86_400_000;
    current = day.totalMs !== null && day.totalMs > 0 ? (adjacent ? current : 0) + 1 : 0;
    longest = Math.max(longest, current);
    previousDate = day.date;
  }
  return longest;
}
