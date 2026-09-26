import test from "node:test";
import assert from "node:assert/strict";
import { freshPomodoro, nextPomodoro, parsePomodoro, pausePomodoro, pomodoroRemaining, runPomodoro, shouldAdvancePomodoro } from "../shared/pomodoro.ts";

test("집중 종료 후 휴식, 휴식 종료 후 다음 집중의 길이와 회차를 계산한다", () => {
  const start = runPomodoro(freshPomodoro(25), 1_000);
  assert.equal(pomodoroRemaining(start, 10_000), 1_491_000);
  assert.equal(pomodoroRemaining(start, 1_600_000), 0);
  const rest = nextPomodoro(start, 1_600_000, 25, 5);
  assert.deepEqual([rest.phase, rest.rounds, rest.endsAt], ["break", 1, 1_900_000]);
  const resumed = nextPomodoro(rest, 1_900_000, 30, 10);
  assert.deepEqual([resumed.phase, resumed.rounds, resumed.endsAt], ["focus", 1, 3_700_000]);
});

test("수동 일시정지는 남은 시간을 보존하고 재개 시 새 종료 시각을 잡는다", () => {
  const start = runPomodoro(freshPomodoro(25), 1_000);
  const paused = pausePomodoro(start, 601_000);
  assert.equal(paused.remainingMs, 900_000);
  assert.equal(paused.endsAt, null);
  assert.equal(runPomodoro(paused, 701_000).endsAt, 1_601_000);
});

test("응답 대기 중 새로고침되면 자동 전환을 중단한다", () => {
  const pending = { ...runPomodoro(freshPomodoro(), Date.now()), status: "transition", endsAt: null };
  assert.equal(parsePomodoro(JSON.stringify(pending)).status, "halted");
  assert.deepEqual(parsePomodoro(JSON.stringify({ ...pending, phase: "invalid" })), freshPomodoro());
  assert.deepEqual(parsePomodoro("{"), freshPomodoro());
});

test("화면이 보이고 복귀 후 상태 확인이 끝난 경우에만 자동 전환한다", () => {
  const focus = runPomodoro(freshPomodoro(), 1_000);
  const deadline = focus.endsAt;
  assert.equal(shouldAdvancePomodoro(focus, deadline, false, deadline, 0), false);
  assert.equal(shouldAdvancePomodoro(focus, deadline, true, deadline - 1, deadline), false);
  assert.equal(shouldAdvancePomodoro(focus, deadline, true, null, 0), false);
  assert.equal(shouldAdvancePomodoro(focus, deadline, true, deadline - 45_001, 0), false);
  assert.equal(shouldAdvancePomodoro(focus, deadline - 1, true, deadline, 0), false);
  assert.equal(shouldAdvancePomodoro(focus, deadline, true, deadline, deadline), true);
  assert.equal(shouldAdvancePomodoro(pausePomodoro(focus, 1000), deadline, true, deadline, 0), false);
});
