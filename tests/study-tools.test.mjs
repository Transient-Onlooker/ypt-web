import test from "node:test";
import assert from "node:assert/strict";
import { freshInterval, intervalRemaining, parseInterval, parseIntervalSettings, parsePlan } from "../shared/study-tools.ts";

test("카운트다운은 탭이 멈췄다가 돌아와도 종료 시각으로 계산한다", () => {
  const timer = { ...freshInterval("focus"), endsAt: 1_500_000 };
  assert.equal(intervalRemaining(timer, 100_000), 1_400_000);
  assert.equal(intervalRemaining(timer, 1_500_000), 0);
  assert.equal(intervalRemaining(timer, 1_700_000), 0);
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
