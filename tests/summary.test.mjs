import test from "node:test";
import assert from "node:assert/strict";
import { formatDaySummary, formatDayCsv, formatTrendCsv, formatTrendSubjectsCsv, formatTrendReview, longestVerifiedStreak, compareVerifiedWeeks, summarizeTrendSubjects, verifiedGoalStreak } from "../shared/format.ts";

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

test("period subject totals use only complete verified days and compare the two weeks", () => {
  const days = Array.from({ length: 14 }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, "0")}`,
    totalMs: index < 7 ? 3_600_000 : 7_200_000,
    subjectTimesAvailable: true,
    subjects: [{ title: "수학", studyMs: index < 7 ? 3_600_000 : 7_200_000, color: "#123456" }],
  }));
  assert.deepEqual(summarizeTrendSubjects(days, 14), [{
    title: "수학", color: "#123456", totalMs: 75_600_000,
    earlierMs: 25_200_000, recentMs: 50_400_000,
  }]);
  assert.match(formatTrendSubjectsCsv(days, 14), /"날짜","완료 총시간","수학"/);
  days[3].subjectTimesAvailable = false;
  assert.equal(summarizeTrendSubjects(days, 14), null);
  assert.equal(formatTrendSubjectsCsv(days, 14), null);
  days[3].subjectTimesAvailable = true;
  days[3].subjects[0].studyMs = null;
  assert.equal(summarizeTrendSubjects(days, 14), null);
});

test("subject period CSV escapes an unsafe name and keeps verified absent subjects at zero", () => {
  const days = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, "0")}`,
    totalMs: index === 0 ? 1_000 : 0,
    subjectTimesAvailable: true,
    subjects: index === 0 ? [{ title: '=test("x")', studyMs: 1_000 }] : [],
  }));
  const csv = formatTrendSubjectsCsv(days, 7);
  assert.match(csv, /"'=test\(""x""\)"/);
  assert.match(csv, /"2026-09-02","00:00:00","00:00:00"/);
  days[1].totalMs = null;
  assert.equal(formatTrendSubjectsCsv(days, 7), null);
});

test("period review names missing dates and never invents a week comparison", () => {
  const days = Array.from({ length: 14 }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, "0")}`,
    totalMs: index === 3 ? null : 3_600_000,
    subjectTimesAvailable: index !== 3,
    subjects: index === 3 ? [] : [{ title: "=위험\n과목", studyMs: 3_600_000 }],
  }));
  const review = formatTrendReview(days, 14, 60);
  assert.match(review, /확인된 13\/14일/);
  assert.match(review, /미확인 날짜: 2026-09-04/);
  assert.match(review, /앞뒤 7일 비교 미확인/);
  assert.match(review, /과목별 기간 시간 미확인/);
  assert.doesNotMatch(review, /=위험/);
  days[3].totalMs = 3_600_000;
  days[3].subjectTimesAvailable = true;
  days[3].subjects = [{ title: "=위험\n과목", studyMs: 3_600_000 }];
  const complete = formatTrendReview(days, 14, 60);
  assert.match(complete, /이전 7일 07:00:00 → 최근 7일 07:00:00/);
  assert.match(complete, /'=위험 과목 14:00:00/);
  assert.doesNotMatch(complete, /\n과목 14/);
});

test("current goal streak stops at a short, unknown, or missing day", () => {
  const days = [
    { date: "2026-09-23", totalMs: 3_600_000 },
    { date: "2026-09-24", totalMs: null },
    { date: "2026-09-25", totalMs: 3_600_000 },
    { date: "2026-09-26", totalMs: 3_600_000 },
  ];
  assert.equal(verifiedGoalStreak(days, 60), 2);
  assert.equal(verifiedGoalStreak(days, 90), 0);
  assert.equal(verifiedGoalStreak([{ ...days[3], totalMs: null }], 60), null);
  assert.equal(verifiedGoalStreak([days[0], days[2]], 60), 1);
});
