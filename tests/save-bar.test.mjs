import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'hikmah-save-bar-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, 'save-bar.cjs');
await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { SaveBar } from './components/app/save-bar';
      export function render(props) {
        return renderToStaticMarkup(
          createElement(SaveBar, {
            dirty: false,
            busy: false,
            onSave: () => {},
            onDiscard: () => {},
            ...props,
          }),
        );
      }
    `,
    resolveDir: root,
    sourcefile: 'save-bar-test.tsx',
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
});
const { render } = createRequire(import.meta.url)(output);

test('a clean form renders no save bar', () => {
  assert.equal(render({ dirty: false }), '');
});

test('a dirty form shows exactly one save convention: Save + Discard', () => {
  const html = render({ dirty: true });
  assert.ok(html.includes('You have unsaved changes.'));
  assert.ok(html.includes('Save changes'));
  assert.ok(html.includes('Discard'));
  assert.ok(html.includes('role="status"'));
  const buttons = html.match(/<button/g) ?? [];
  assert.equal(buttons.length, 2);
});

test('while saving, both actions are disabled and the button says so', () => {
  const html = render({ dirty: true, busy: true });
  assert.ok(html.includes('Saving…'));
  const disabled = html.match(/disabled/g) ?? [];
  assert.ok(disabled.length >= 2);
});
