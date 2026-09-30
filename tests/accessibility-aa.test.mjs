import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const tools = readFileSync(new URL("../src/study-tools.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const source = main + "\n" + tools;

test("document declares Korean and does not disable browser zoom", () => {
  assert.match(html, /<html\s+lang="ko"/);
  const viewport = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/)?.[1] ?? "";
  assert.ok(viewport.includes("width=device-width"));
  assert.doesNotMatch(viewport, /user-scalable\s*=\s*no/i);
  assert.doesNotMatch(viewport, /maximum-scale\s*=\s*1(?:\.0+)?(?:,|$)/i);
});

test("main content has a keyboard bypass link", () => {
  assert.match(main, /<a\s+className="skip-link"\s+href="#main-content">본문으로 이동<\/a>/);
  assert.match(main, /<main\s+id="main-content"\s+tabIndex=\{-1\}>/);
});

test("literal form controls have programmatic labels", () => {
  for (const match of source.matchAll(/<(input|select|textarea)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const [element, tag, id] = match;
    const labelled = source.includes(`htmlFor="${id}"`) ||
      /\baria-label=|\baria-labelledby=/.test(element);
    assert.ok(labelled, `${tag}#${id} must have an associated label`);
  }
});

test("click handlers stay on native interactive controls", () => {
  const bad = [...source.matchAll(
    /<(div|span|section|article|li|p|strong|small)\b[^>]*\bonClick\s*=\s*\{/g,
  )];
  assert.deepEqual(bad.map((match) => match[0]), []);
});

test("no positive tabindex or hidden focus outline is introduced", () => {
  assert.doesNotMatch(source, /tabIndex=\{?[1-9]\d*\}?/);
  assert.doesNotMatch(css, /outline\s*:\s*(?:none|0)\b/i);
});

test("focus visibility accounts for sticky header and mobile bottom navigation", () => {
  assert.match(css, /scroll-padding-top:\s*92px/);
  assert.match(css, /scroll-padding-bottom:\s*104px/);
  assert.match(css, /scroll-margin-bottom:\s*104px/);
});

test("target-size safeguards cover custom checkboxes and primary touch controls", () => {
  assert.match(css, /\.remember-email\s*\{[\s\S]*?min-height:\s*32px/);
  assert.match(css, /\.bottom-nav button\s*\{[\s\S]*?min-height:\s*52px/);
  assert.match(css, /\.date-actions button\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(css, /\.timer-mode button\s*\{[\s\S]*?min-height:\s*44px/);
});

test("mobile status can reflow and body does not force a 320px minimum", () => {
  assert.match(css, /\.top-status\s*\{[\s\S]*?white-space:\s*normal/);
  assert.match(css, /body\s*\{[\s\S]*?min-width:\s*0/);
});

test("accessible names retain visible labels", () => {
  assert.match(main, /aria-label=\{\`\$\{label\} · \$\{dark \? "라이트 모드로 변경" : "다크 모드로 변경"\}\`\}/);
  assert.match(main, /aria-label="← 이전 · 이전 날짜"/);
  assert.match(main, /aria-label="다음 → · 다음 날짜"/);
  assert.match(main, /aria-label="− · 집중 시간 1분 줄이기"/);
  assert.match(main, /aria-label="\+ · 휴식 시간 1분 늘리기"/);
});

test("accessible authentication keeps password-manager semantics and does not block paste", () => {
  assert.match(main, /autoComplete="username"/);
  assert.match(main, /autoComplete="current-password"/);
  assert.doesNotMatch(source, /onPaste\s*=|clipboardData/);
});

test("statistics controls remain usable on narrow screens", () => {
  assert.match(css, /@media \(max-width:\s*650px\)[\s\S]*?\.stats-toolbar \.history-trend-actions\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
  assert.match(css, /\.stats-toolbar \.trend-range select\s*\{[\s\S]*?width:\s*100%/);
  assert.match(css, /@media \(max-width:\s*430px\)[\s\S]*?\.stats-toolbar \.history-trend-actions\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
});

test("statistics typography and alignment stay stable", () => {
  assert.match(css, /\.insights-card\s*\{[\s\S]*?padding-inline:\s*22px/);
  assert.match(css, /word-break:\s*keep-all/);
  assert.match(css, /\.stats-toolbar h2,[\s\S]*?\.stats-metric strong\s*\{[\s\S]*?letter-spacing:\s*0/);
  assert.match(css, /\.stats-chart-panel \.week-calendar-day small[\s\S]*?white-space:\s*nowrap/);
});

test("live status indicators are driven by the theme accent variable", () => {
  assert.match(css, /\.status-dot\.live,[\s\S]*?\.member-indicator\.live\s*\{[\s\S]*?background:\s*var\(--accent\)/);
});
