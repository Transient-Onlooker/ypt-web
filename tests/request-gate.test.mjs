import test from "node:test";
import assert from "node:assert/strict";
import { RequestGate } from "../shared/request-gate.ts";

test("slow automatic refresh is allowed to finish before another starts", () => {
  const gate = new RequestGate();
  const first = gate.start();
  assert.notEqual(first, null);
  assert.equal(gate.start(), null);
  assert.equal(gate.finish(first), true);
  assert.notEqual(gate.start(), null);
});

test("forced refresh supersedes a slow poll without losing the new result", () => {
  const gate = new RequestGate();
  const poll = gate.start();
  const afterTimerChange = gate.start(true);
  assert.notEqual(afterTimerChange, poll);
  assert.equal(gate.finish(poll), false);
  assert.equal(gate.start(), null);
  assert.equal(gate.isCurrent(afterTimerChange), true);
  assert.equal(gate.finish(afterTimerChange), true);
});

test("logout invalidates outstanding refreshes and permits a new account", () => {
  const gate = new RequestGate();
  const oldAccount = gate.start();
  gate.invalidate();
  const newAccount = gate.start();
  assert.equal(gate.finish(oldAccount), false);
  assert.equal(gate.isCurrent(newAccount), true);
  assert.equal(gate.finish(newAccount), true);
});
