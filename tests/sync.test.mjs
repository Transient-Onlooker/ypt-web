import test from "node:test";
import assert from "node:assert/strict";
import { groupListRefreshMs, statusStaleAfterMs } from "../shared/sync.ts";

test("status freshness follows long sync intervals without false stale state", () => {
  assert.equal(statusStaleAfterMs(10), 45_000);
  assert.equal(statusStaleAfterMs(30), 45_000);
  assert.equal(statusStaleAfterMs(60), 65_000);
  assert.equal(statusStaleAfterMs(120), 125_000);
});

test("group list refresh is capped at a slower cadence than live member status", () => {
  assert.equal(groupListRefreshMs(10), 60_000);
  assert.equal(groupListRefreshMs(60), 60_000);
  assert.equal(groupListRefreshMs(120), 120_000);
});
