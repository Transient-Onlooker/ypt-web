import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTimerContinuity,
  pauseTimerContinuity,
  resumeTimerContinuity,
  startTimerContinuity,
  timerContinuityElapsed,
} from "../shared/timer-continuity.ts";

test("a quick resume carries the previous focus time when the API returns a new start", () => {
  const first = startTimerContinuity("Math", 1_000);
  const paused = pauseTimerContinuity(first, "Math", 1_000, 31_000, 31_000);
  const resumed = resumeTimerContinuity(paused, "Math", 39_000, 39_000);
  assert.equal(timerContinuityElapsed(resumed, "Math", 39_000, 40_000), 31_000);
});

test("a quick resume keeps the canonical timestamp returned by the API", () => {
  const first = startTimerContinuity("Math", 1_000);
  const paused = pauseTimerContinuity(first, "Math", 1_000, 31_000, 31_000);
  const resumed = resumeTimerContinuity(paused, "Math", 1_000, 39_000);
  assert.equal(timerContinuityElapsed(resumed, "Math", 1_000, 40_000), 39_000);
});

test("exactly 15 seconds carries time, but a longer pause starts a fresh display", () => {
  const first = startTimerContinuity("Math", 1_000);
  const paused = pauseTimerContinuity(first, "Math", 1_000, 31_000, 31_000);
  const quickResume = resumeTimerContinuity(paused, "Math", 39_000, 46_000);
  const laterResume = resumeTimerContinuity(paused, "Math", 50_000, 46_001);
  assert.equal(timerContinuityElapsed(quickResume, "Math", 39_000, 40_000), 31_000);
  assert.equal(timerContinuityElapsed(laterResume, "Math", 50_000, 51_000), 1_000);
});

test("a delayed pause confirmation does not extend the 15-second resume window", () => {
  const first = startTimerContinuity("Math", 1_000);
  const pausedAtClick = 31_000;
  const paused = pauseTimerContinuity(first, "Math", 1_000, 31_000, pausedAtClick);
  const resumed = resumeTimerContinuity(paused, "Math", 50_000, 46_001);
  assert.equal(timerContinuityElapsed(resumed, "Math", 50_000, 51_000), 1_000);
});

test("multiple quick pauses keep carrying the accumulated focus time", () => {
  const first = startTimerContinuity("Math", 1_000);
  const firstPause = pauseTimerContinuity(first, "Math", 1_000, 31_000, 31_000);
  const firstResume = resumeTimerContinuity(firstPause, "Math", 39_000, 35_000);
  const secondPause = pauseTimerContinuity(firstResume, "Math", 39_000, 69_000, 69_000);
  const secondResume = resumeTimerContinuity(secondPause, "Math", 80_000, 75_000);
  assert.equal(timerContinuityElapsed(secondResume, "Math", 80_000, 85_000), 65_000);
});

test("changing subjects does not carry the previous subject's focus time", () => {
  const first = startTimerContinuity("Math", 1_000);
  const paused = pauseTimerContinuity(first, "Math", 1_000, 31_000, 31_000);
  const resumed = resumeTimerContinuity(paused, "Science", 39_000, 39_000);
  assert.equal(timerContinuityElapsed(resumed, "Science", 39_000, 40_000), 1_000);
});

test("persisted continuity rejects malformed or impossible state", () => {
  const value = startTimerContinuity("Math", 1_000);
  assert.deepEqual(parseTimerContinuity(JSON.stringify(value)), value);
  assert.equal(parseTimerContinuity("{"), null);
  assert.equal(parseTimerContinuity(JSON.stringify({ ...value, subject: "" })), null);
  assert.equal(parseTimerContinuity(JSON.stringify({ ...value, pausedAt: 100 })), null);
});
