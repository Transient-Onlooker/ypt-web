import test from "node:test";
import assert from "node:assert/strict";
import { formatDaySummary, formatDayCsv, formatTrendCsv, longestVerifiedStreak, compareVerifiedWeeks } from "../shared/format.ts";

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

test("daily CSV escapes untrusted subject names and preserves unknown times", () => {
  const csv = formatDayCsv({
    date: "2026-09-26", totalMs: 3_600_000, subjectTimesAvailable: true,
    longestSegmentMs: null,
    subjects: [
      { title: '=HYPERLINK("x")\nnext', studyMs: 3_600_000 },
      { title: "수학", studyMs: null },
    ],
  });
  assert.match(csv, /"'=HYPERLINK\(""x""\) next","01:00:00","확인"/);
  assert.match(csv, /"수학","","미확인"/);
  const unavailable = formatDayCsv({
    date: "2026-09-26", totalMs: 1000, subjectTimesAvailable: false,
    longestSegmentMs: null, subjects: [{ title: "수학", studyMs: 1000 }],
  });
  assert.doesNotMatch(unavailable, /"수학"/);
  assert.match(unavailable, /"과목별 시간","","","미확인"/);
});

test("weekly CSV and streak keep failed days unknown", () => {
  const days = [
    { date: "2026-09-24", totalMs: 3_000 },
    { date: "2026-09-25", totalMs: null },
    { date: "2026-09-26", totalMs: 2_000 },
  ];
  assert.match(formatTrendCsv(days), /"2026-09-25","","미확인"/);
  assert.equal(longestVerifiedStreak(days), 1);
  assert.equal(longestVerifiedStreak([
    { date: "2026-09-25", totalMs: 2_000 },
    { date: "2026-09-24", totalMs: 1_000 },
    { date: "2026-09-26", totalMs: 0 },
  ]), 2);
  assert.equal(longestVerifiedStreak([
    { date: "2026-09-20", totalMs: 1_000 },
    { date: "2026-09-22", totalMs: 1_000 },
  ]), 1);
});

test("two-week comparison requires every day to be verified", () => {
  const days = Array.from({ length: 14 }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, "0")}`,
    totalMs: index < 7 ? 1_000 : 2_000,
  }));
  assert.deepEqual(compareVerifiedWeeks(days), {
    earlier: 7_000, recent: 14_000, difference: 7_000,
  });
  days[3].totalMs = null;
  assert.equal(compareVerifiedWeeks(days), null);
  assert.equal(compareVerifiedWeeks(days.slice(0, 7)), null);
  const withGap = Array.from({ length: 14 }, (_, index) => ({
    date: `2026-09-${String(index + (index > 6 ? 2 : 1)).padStart(2, "0")}`,
    totalMs: 1_000,
  }));
  assert.equal(compareVerifiedWeeks(withGap), null);
});
