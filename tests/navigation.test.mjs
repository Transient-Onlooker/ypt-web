import test from "node:test";
import assert from "node:assert/strict";
import {
  historyDateFromSearch,
  historyViewUrl,
  tabFromSearch,
  tabUrl,
  trendRangeFromSearch,
} from "../shared/navigation.ts";

test("탭 URL은 GitHub Pages 경로와 기존 검색어·앵커를 유지한다", () => {
  const next = new URL(tabUrl("https://ypt.mcv.kr/?lang=ko#main-content", "groups"));
  assert.equal(next.pathname, "/");
  assert.equal(next.searchParams.get("lang"), "ko");
  assert.equal(next.searchParams.get("tab"), "groups");
  assert.equal(next.hash, "#main-content");
});

test("모든 메뉴 URL을 복원하고 잘못된 탭은 공부로 안전하게 돌아간다", () => {
  const href = "https://ypt.mcv.kr/?tab=study";
  const entries = ["study", "today", "plan", "history", "insights", "groups"].map((tab) =>
    tabFromSearch(new URL(tabUrl(href, tab)).search),
  );
  assert.deepEqual(entries, ["study", "today", "plan", "history", "insights", "groups"]);
  assert.equal(tabFromSearch("?tab=unknown"), "study");
  assert.equal(tabFromSearch(""), "study");
});


test("history view state survives reload and rejects invalid dates", () => {
  const href = historyViewUrl(
    "https://ypt.mcv.kr/?tab=insights&lang=ko#main-content",
    { date: "2026-09-29", range: 14 },
  );
  const url = new URL(href);
  assert.equal(historyDateFromSearch(url.search), "2026-09-29");
  assert.equal(trendRangeFromSearch(url.search), 14);
  assert.equal(url.searchParams.get("lang"), "ko");
  assert.equal(url.hash, "#main-content");

  assert.equal(historyDateFromSearch("?date=2026-02-30"), "");
  assert.equal(historyDateFromSearch("?date=not-a-date"), "");
  assert.equal(trendRangeFromSearch("?range=7"), 7);
  assert.equal(trendRangeFromSearch("?range=14"), 14);
  assert.equal(trendRangeFromSearch("?range=30"), 30);
  assert.equal(trendRangeFromSearch("?range=90"), 7);
});

test("history view URL can update one field without dropping the other", () => {
  const original = "https://ypt.mcv.kr/?tab=history&date=2026-09-29&range=14";
  const changedDate = new URL(historyViewUrl(original, { date: "2026-09-28" }));
  assert.equal(changedDate.searchParams.get("date"), "2026-09-28");
  assert.equal(changedDate.searchParams.get("range"), "14");

  const changedRange = new URL(historyViewUrl(changedDate.href, { range: 30 }));
  assert.equal(changedRange.searchParams.get("date"), "2026-09-28");
  assert.equal(changedRange.searchParams.get("range"), "30");
});
