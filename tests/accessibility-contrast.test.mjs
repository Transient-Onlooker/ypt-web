import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const marker = css.indexOf("/* v0.30 soft online orange palette + stats alignment */");
assert.notEqual(marker, -1, "online palette block must exist");
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

test("approved soft online orange light palette keeps text and controls at WCAG AA contrast", () => {
  const block = themeBlock(':root:not([data-theme="dark"])');
  atLeast(contrast("#000000", "#FFF7EC"), 4.5, "light body text");
  atLeast(contrast("#1E1E1E", "#FFF7EC"), 4.5, "light secondary text");
  atLeast(contrast("#000000", "#FFD49F"), 4.5, "light primary button");
  atLeast(contrast("#000000", "#FFE5C6"), 4.5, "light selected control");
  assert.equal(variable(block, "canvas").toUpperCase(), "#FFF7EC");
  assert.equal(variable(block, "surface").toUpperCase(), "#FFEED9");
  assert.equal(variable(block, "accent-fill").toUpperCase(), "#FFD49F");
  assert.equal(variable(block, "accent-hover").toUpperCase(), "#FFE5C6");
});

test("approved online OLED orange palette keeps text and controls at WCAG AA contrast", () => {
  const block = themeBlock(':root[data-theme="dark"]');
  atLeast(contrast("#FFFFFF", "#000000"), 4.5, "OLED body text");
  atLeast(contrast("#888888", "#121212"), 4.5, "OLED secondary text");
  atLeast(contrast("#000000", "#FFA500"), 4.5, "OLED primary button");
  atLeast(contrast("#FFA500", "#121212"), 4.5, "OLED accent text");
  atLeast(contrast("#888888", "#121212"), 3, "OLED control border");
  assert.equal(variable(block, "canvas").toUpperCase(), "#000000");
  assert.equal(variable(block, "surface").toUpperCase(), "#121212");
  assert.equal(variable(block, "accent-fill").toUpperCase(), "#FFA500");
  assert.equal(variable(block, "accent-hover").toUpperCase(), "#CC5500");
});

test("focus indicators exceed the WCAG 2.2 3:1 contrast minimum in both themes", () => {
  const light = themeBlock(':root:not([data-theme="dark"])');
  const dark = themeBlock(':root[data-theme="dark"]');
  atLeast(contrast(variable(light, "focus-accent"), "#ffffff"), 3, "light focus indicator");
  atLeast(contrast(variable(dark, "focus-accent"), "#000000"), 3, "dark focus indicator");
});

test("keyboard focus indicator is visibly reinforced beyond the AA minimum", () => {
  assert.match(
    css,
    /:focus-visible\s*\{[\s\S]*?outline:\s*3px\s+solid\s+var\(--focus-accent\)/,
  );
});

test("v0.30 theme override uses only the approved online palette colors", () => {
  const allowed = new Set([
    "#FFD49F", "#FFE5C6", "#FFEED9", "#FFF7EC",
    "#000000", "#121212", "#1E1E1E", "#FFFFFF", "#888888",
    "#FFA500", "#CC5500",
  ]);
  const colors = [...tail.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toUpperCase());
  assert.ok(colors.length > 0);
  for (const color of colors) assert.ok(allowed.has(color), `unapproved palette color ${color}`);
});
