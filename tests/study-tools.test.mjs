import test from "node:test";
import assert from "node:assert/strict";
import { bulkPlanCandidates, eligibleCarryOver, freshInterval, intervalRemaining, parseInterval, parseIntervalSettings, parsePlan, planTemplate, previousCalendarDate, summarizePlannedSubjects } from "../shared/study-tools.ts";

test("카운트다운은 탭이 멈췄다가 돌아와도 종료 시각으로 계산한다", () => {
  const timer = { ...freshInterval("focus"), endsAt: 1_500_000 };
  assert.equal(intervalRemaining(timer, 100_000), 1_400_000);
  assert.equal(intervalRemaining(timer, 1_500_000), 0);
  assert.equal(intervalRemaining(timer, 1_700_000), 0);
});

test("전날 미완료 계획만 중복 없이 오늘로 옮긴다", () => {
  const previous = [
    { id: "1", text: "수학", estimateMinutes: 25, done: true },
    { id: "2", text: "영어", estimateMinutes: 45, done: false },
    { id: "3", text: "국어", estimateMinutes: 30, done: false },
  ];
  assert.equal(previousCalendarDate("2026-03-01"), "2026-02-28");
  assert.deepEqual(eligibleCarryOver([], previous).map((item) => item.text), ["영어", "국어"]);
  assert.deepEqual(eligibleCarryOver([{ ...previous[1], text: " 영어 " }], previous)
    .map((item) => item.text), ["국어"]);
  assert.equal(eligibleCarryOver(Array.from({ length: 12 }, (_, index) =>
    ({ ...previous[0], id: String(index), text: `과목 ${index}` })), previous).length, 0);
  assert.deepEqual(planTemplate(previous).map((item) => item.done), [false, false, false]);
  assert.equal(previous[0].done, true);
});

test("여러 할 일 입력은 중복과 길이 제한을 적용한다", () => {
  const current = [{ id: "1", text: "영어", estimateMinutes: 25, done: false }];
  assert.deepEqual(bulkPlanCandidates(" 영어 \n수학\n수학\n국어\n" + "가".repeat(81), current),
    ["수학", "국어"]);
  assert.equal(bulkPlanCandidates(Array.from({ length: 20 }, (_, i) => `일 ${i}`).join("\n"), current).length, 11);
});

test("과목 계획은 전체 예상 시간과 검증된 오늘 완료 기록을 구분한다", () => {
  const items = [
    { id: "1", text: "수학 1", estimateMinutes: 25, done: true, subjectTitle: "수학" },
    { id: "2", text: "수학 2", estimateMinutes: 30, done: false, subjectTitle: "수학" },
    { id: "3", text: "연결 없음", estimateMinutes: 60, done: false },
  ];
  const day = { date: "2026-09-26", totalMs: 3_600_000,
    subjectTimesAvailable: true, longestSegmentMs: null,
    subjects: [{ title: "수학", studyMs: 3_600_000, color: "#123456" }],
  };
  assert.deepEqual(summarizePlannedSubjects(items, day), [{
    title: "수학", plannedMs: 3_300_000, recordedMs: 3_600_000, color: "#123456",
  }]);
  assert.equal(summarizePlannedSubjects(items, { ...day, subjectTimesAvailable: false })[0].recordedMs, null);
  assert.equal(summarizePlannedSubjects(items, { ...day, subjects: [] })[0].recordedMs, 0);
  assert.equal(summarizePlannedSubjects(items, { ...day, subjects: [
    { title: "수학", studyMs: null },
  ] })[0].recordedMs, null);
  assert.equal(parsePlan(JSON.stringify(items)).length, 3);
  assert.deepEqual(parsePlan(JSON.stringify([{ ...items[0], subjectTitle: 123 }])), []);
});

test("손상되거나 범위를 벗어난 세션 저장값은 버린다", () => {
  const valid = [{ id: "a", text: "영어 복습", estimateMinutes: 25, done: false }];
  assert.deepEqual(parsePlan(JSON.stringify(valid)), valid);
  assert.deepEqual(parsePlan(JSON.stringify([...valid, ...valid])), []);
  assert.deepEqual(parsePlan(JSON.stringify([{ ...valid[0], estimateMinutes: 10000 }])), []);
  assert.deepEqual(parsePlan("{"), []);
  assert.deepEqual(parseInterval(JSON.stringify({ ...freshInterval(), phase: "toString" })), freshInterval());
  assert.deepEqual(parseInterval(JSON.stringify({ ...freshInterval(), endsAt: -1 })), freshInterval());
  assert.deepEqual(parseInterval(JSON.stringify({ ...freshInterval(), endsAt: Date.now() + 181 * 60_000 })), freshInterval());
  assert.deepEqual(parseIntervalSettings(JSON.stringify({ focus: 45, short: 10, long: 20 })),
    { focus: 45, short: 10, long: 20 });
  assert.deepEqual(parseIntervalSettings(JSON.stringify({ focus: 0, short: 10, long: 20 })),
    { focus: 25, short: 5, long: 15 });
});
