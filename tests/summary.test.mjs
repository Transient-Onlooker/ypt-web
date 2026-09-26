import test from "node:test";
import assert from "node:assert/strict";
import { formatDaySummary } from "../shared/format.ts";

test("copied summary includes completed time and only verified subject times", () => {
  const result = formatDaySummary({
    date: "2026-09-25",
    totalMs: 4_000_000,
    subjectTimesAvailable: true,
    longestSegmentMs: null,
    subjects: [
      { title: "영어", studyMs: null },
      { title: "수학\n심화", studyMs: 3_600_000 },
      { title: "국어", studyMs: 400_000 },
    ],
  });
  assert.equal(result,
    "YPT Web · 오늘의 공부 (2026-09-25)\n완료 기록 01:06:40\n수학 심화 01:00:00\n국어 00:06:40");
  assert.doesNotMatch(result, /영어/);
});

test("copied summary marks unavailable subject times instead of guessing", () => {
  const result = formatDaySummary({
    date: "2026-09-25",
    totalMs: 10_000,
    subjectTimesAvailable: false,
    longestSegmentMs: null,
    subjects: [{ title: "수학", studyMs: 10_000 }],
  });
  assert.equal(result,
    "YPT Web · 오늘의 공부 (2026-09-25)\n완료 기록 00:00:10\n과목별 시간 미확인");
});
