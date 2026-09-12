/** The markdown renderer is wired through CSS and package side effects that no
 * other test touches, and each failure here is silent or subtle in a browser:
 * a missing stylesheet renders every formula twice, a missing @source line
 * strips the answer's styling, and a diverging plugin set makes two places
 * render the same answer differently. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile('app/globals.css', 'utf8');
const playground = await readFile('components/playground/message-content.tsx', 'utf8');
const elements = await readFile('components/ai-elements/message.tsx', 'utf8');

test('KaTeX styling is imported, so a formula renders once and not twice', () => {
  // @streamdown/math names this path from getStyles() and leaves the import to
  // the app; without it .katex-mathml is not hidden and its MathML twin shows.
  assert.match(css, /@import 'katex\/dist\/katex\.min\.css';/);
  const imports = [...css.matchAll(/^@import .*$/gm)].map((m) => m.index);
  const firstRule = css.search(/^[.:@[a-zA-Z*][^\n]*\{$/m);
  assert.ok(Math.max(...imports) < firstRule, '@import must precede every rule');
});

test("Tailwind's dark variant follows the saved theme, not the operating system", () => {
  // Otherwise a dark page renders Shiki's light palette, and every dark: class
  // in components/ui and components/ai-elements disagrees with the page.
  assert.match(css, /@custom-variant dark \(&:where\(\[data-theme='dark'\]/);
});

test('every streamdown package Tailwind must scan is declared as a source', () => {
  for (const pkg of ['streamdown', '@streamdown/code', '@streamdown/math', '@streamdown/mermaid']) {
    assert.ok(
      css.includes(`@source '../node_modules/${pkg}/dist/*.js';`),
      `missing @source for ${pkg}`,
    );
  }
});

test('every place that renders markdown uses the same renderer and plugins', () => {
  for (const source of [playground, elements]) {
    assert.match(source, /from 'streamdown'|from "streamdown"/);
    assert.match(source, /\{ cjk, code, math, mermaid \}/);
  }
  assert.doesNotMatch(playground, /react-markdown/);
});

test('the answer no longer hides a long code block behind a disclosure', () => {
  // Streamdown scrolls a long block in place; the old renderer collapsed it.
  assert.doesNotMatch(playground, /<details/);
  assert.doesNotMatch(playground, /split\('\\n'\)\.length/);
});

test('the hand-rolled code block and table wrapper leave no dead CSS behind', () => {
  for (const dead of ['.code-block', '.markdown-table']) {
    assert.ok(!css.includes(dead), `${dead} is styled but nothing renders it`);
  }
});

// A test lived here asserting that the playground chat's tool activity and run
// stages were readable rows rather than a second disclosure. Both files it read
// — components/playground/{chat,execution-view}.tsx — are gone with the browser
// run loop; components/chat/message-parts.tsx renders tool activity now, and
// tests/chat-surface covers it.
