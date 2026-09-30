import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const marker = css.indexOf("/* v0.26 accessibility contrast */");
assert.notEqual(marker, -1, "accessibility contrast block must exist");
const tail = css.slice(marker);

function themeBlock(selector) {
  const start = tail.indexOf(selector);
  assert.notEqual(start, -1, `missing theme block: ${selector}`);
  const open = tail.indexOf("{", start);
  const close = tail.indexOf("}", open);
  return tail.slice(open + 1, close);
}

function variable(block, name) {
  const match = block.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `missing --${name}`);
  return match[1];
}

function channel(value) {
  const srgb = value / 255;
  return srgb <= 0.04045
    ? srgb / 12.92
    : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const raw = hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((offset) =>
    Number.parseInt(raw.slice(offset, offset + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function atLeast(actual, expected, label) {
  assert.ok(actual >= expected, `${label}: expected >= ${expected}:1, got ${actual.toFixed(3)}:1`);
}

test("light palette keeps primary and emphasis text at WCAG AAA contrast", () => {
  const block = themeBlock(':root:not([data-theme="dark"])');
  atLeast(contrast(variable(block, "accent-fill"), "#ffffff"), 7, "primary white text");
  atLeast(contrast(variable(block, "accent-hover"), "#ffffff"), 7, "primary hover white text");
  atLeast(contrast(variable(block, "accent-text"), "#ffffff"), 7, "accent text");
  atLeast(contrast(variable(block, "subtle"), "#ffffff"), 7, "subtle text");
  atLeast(contrast(variable(block, "accent-on-dark"), "#000000"), 7, "sidebar accent text");
  atLeast(contrast(variable(block, "danger-text"), "#ffffff"), 7, "danger text");
  atLeast(contrast(variable(block, "warning-text"), "#ffffff"), 7, "warning text");
});

test("dark palette keeps emphasis text at WCAG AAA and graphics at AA contrast", () => {
  const block = themeBlock(':root[data-theme="dark"]');
  atLeast(contrast(variable(block, "accent-fill"), "#ffffff"), 7, "primary white text");
  atLeast(contrast(variable(block, "accent-hover"), "#ffffff"), 7, "primary hover white text");
  atLeast(contrast(variable(block, "accent-text"), "#000000"), 7, "accent text");
  atLeast(contrast(variable(block, "subtle"), "#000000"), 7, "subtle text");
  atLeast(contrast(variable(block, "accent-border"), "#000000"), 3, "primary component border");
  atLeast(contrast(variable(block, "chart-accent"), "#000000"), 3, "chart accent");
  atLeast(contrast(variable(block, "danger-text"), "#000000"), 7, "danger text");
  atLeast(contrast(variable(block, "warning-text"), "#000000"), 7, "warning text");
});

test("focus indicators exceed the WCAG 2.2 3:1 contrast minimum in both themes", () => {
  const light = themeBlock(':root:not([data-theme="dark"])');
  const dark = themeBlock(':root[data-theme="dark"]');
  atLeast(contrast(variable(light, "focus-accent"), "#ffffff"), 3, "light focus indicator");
  atLeast(contrast(variable(dark, "focus-accent"), "#000000"), 3, "dark focus indicator");
});

test("light member state chips keep normal-size text at AAA contrast", () => {
  atLeast(contrast("#0f4f2d", "#dff3e4"), 7, "studying chip");
  atLeast(contrast("#31473b", "#e9eeeb"), 7, "resting chip");
  atLeast(contrast("#5c3600", "#f8ead3"), 7, "unknown chip");
});


test("keyboard focus indicator uses at least a 2px perimeter-equivalent outline", () => {
  assert.match(
    tail,
    /:focus-visible\s*\{[\s\S]*?outline:\s*3px\s+solid\s+var\(--focus-accent\)/,
  );
});
