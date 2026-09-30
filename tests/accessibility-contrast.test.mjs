import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const study = readFileSync(new URL("../src/study-tools.tsx", import.meta.url), "utf8");

function block(selector) {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `missing block: ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function variable(source, name) {
  const match = source.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `missing --${name}`);
  return match[1];
}

function channel(value) {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
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

test("light theme uses the approved soft-orange palette and meets AA", () => {
  const light = block(":root {");
  assert.equal(variable(light, "bg").toUpperCase(), "#FFF7EC");
  assert.equal(variable(light, "surface").toUpperCase(), "#FFEED9");
  assert.equal(variable(light, "surface-soft").toUpperCase(), "#FFE5C6");
  assert.equal(variable(light, "accent").toUpperCase(), "#FFD49F");
  assert.equal(variable(light, "text").toUpperCase(), "#000000");
  assert.equal(variable(light, "text-muted").toUpperCase(), "#1E1E1E");
  atLeast(contrast("#000000", "#FFF7EC"), 4.5, "light body text");
  atLeast(contrast("#1E1E1E", "#FFF7EC"), 4.5, "light secondary text");
  atLeast(contrast("#000000", "#FFD49F"), 4.5, "light accent control");
});

test("dark theme is true-black OLED with the approved orange accent and meets AA", () => {
  const dark = block(':root[data-theme="dark"]');
  assert.equal(variable(dark, "bg").toUpperCase(), "#000000");
  assert.equal(variable(dark, "surface").toUpperCase(), "#121212");
  assert.equal(variable(dark, "surface-soft").toUpperCase(), "#1E1E1E");
  assert.equal(variable(dark, "accent").toUpperCase(), "#FFA500");
  assert.equal(variable(dark, "accent-hover").toUpperCase(), "#CC5500");
  assert.equal(variable(dark, "text").toUpperCase(), "#FFFFFF");
  assert.equal(variable(dark, "text-muted").toUpperCase(), "#888888");
  atLeast(contrast("#FFFFFF", "#000000"), 4.5, "OLED body text");
  atLeast(contrast("#888888", "#121212"), 4.5, "OLED secondary text");
  atLeast(contrast("#000000", "#FFA500"), 4.5, "OLED accent control");
  atLeast(contrast("#FFA500", "#121212"), 4.5, "OLED accent text");
});

test("focus indicator remains high contrast", () => {
  assert.match(css, /:focus-visible\s*\{[\s\S]*?outline:\s*3px\s+solid\s+var\(--focus\)/);
  atLeast(contrast("#000000", "#FFF7EC"), 3, "light focus");
  atLeast(contrast("#FFA500", "#000000"), 3, "dark focus");
});

test("runtime theme source contains no legacy hard-coded palette colors", () => {
  const allowed = new Set([
    "#FFD49F", "#FFE5C6", "#FFEED9", "#FFF7EC",
    "#000000", "#121212", "#1E1E1E", "#FFFFFF", "#888888",
    "#FFA500", "#CC5500",
  ]);
  for (const [name, source] of [["style.css", css], ["main.tsx", main], ["study-tools.tsx", study]]) {
    const colors = [...source.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toUpperCase());
    for (const color of colors) {
      assert.ok(allowed.has(color), `${name} contains unapproved color ${color}`);
    }
  }
});

test("component rules use theme variables instead of literal colors", () => {
  const themeEnd = css.indexOf("* {");
  assert.ok(themeEnd > 0);
  const components = css.slice(themeEnd);
  assert.doesNotMatch(components, /#[0-9a-fA-F]{3,8}\b/);
  assert.match(components, /background:\s*var\(--accent\)/);
  assert.match(components, /color:\s*var\(--text\)/);
});


test("legacy theme-specific component selectors are completely removed", () => {
  const darkSelectors = [...css.matchAll(/:root\[data-theme="dark"\]/g)];
  assert.equal(darkSelectors.length, 1, "only the canonical dark token block may use :root[data-theme=dark]");
  assert.doesNotMatch(css, /:root:not\(\[data-theme="dark"\]\)/);
});

test("large dark surfaces use neutral theme surfaces, not the accent", () => {
  assert.match(css, /\.topbar,[\s\S]*?\.settings-popover\s*\{[\s\S]*?background:\s*var\(--surface\)/);
  assert.match(css, /\.timer-card,[\s\S]*?\.week-row\s*\{[\s\S]*?background:\s*var\(--surface\)/);
  assert.doesNotMatch(css, /:root\[data-theme="dark"\][^{]*\.timer-card[\s\S]*?background:\s*var\(--accent\)/);
});


test("timer modes keep distinct top-border accents without recoloring the card surface", () => {
  assert.match(css, /\.timer-card\.is-normal-mode\s*\{\s*border-top-color:\s*var\(--accent\);\s*\}/);
  assert.match(css, /\.timer-card\.is-pomodoro-mode\s*\{\s*border-top-color:\s*var\(--accent-hover\);\s*\}/);
  assert.match(css, /\.timer-card,[\s\S]*?background:\s*var\(--surface\)/);
});
