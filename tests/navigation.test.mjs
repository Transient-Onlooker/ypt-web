import test from "node:test";
import assert from "node:assert/strict";
import { tabFromSearch, tabUrl } from "../shared/navigation.ts";

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
