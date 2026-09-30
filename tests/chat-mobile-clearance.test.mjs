// The two mobile UI fixes for the greeting ticket (2026-09-30):
//
// 1. Follow-up chips WRAP instead of scrolling: on a 390px phone the shared
//    .n-chip-row scroll row left the last chip half-cut with no scroll
//    affordance, reading as broken. The wrap override is scoped to
//    [data-slot='follow-up-chips'] only; the "Keep going" label's
//    min-width:0 chain (the v1 overflow fix) stays intact.
// 2. The last turn clears the floating composer via a real end-of-transcript
//    spacer element: bottom padding alone did not hold on phones, because
//    the stick-to-bottom scroller nests inside the transcript box.
// Run: node --test tests/chat-mobile-clearance.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const css = await readFile(join(root, 'app/styles/chat-experience.css'), 'utf8');
const chatView = await readFile(join(root, 'components/chat/chat-view.tsx'), 'utf8');

const blocksFor = (selector) => {
  const blocks = [];
  let from = 0;
  while (true) {
    const idx = css.indexOf(selector, from);
    if (idx === -1) break;
    // The rule's block ends at the first closing brace after the selector.
    const end = css.indexOf('}', idx);
    blocks.push(css.slice(idx, end));
    from = end;
  }
  assert.ok(blocks.length > 0, `CSS must define ${selector}`);
  return blocks;
};

test('follow-up chips wrap instead of scrolling', () => {
  const [block] = blocksFor("[data-slot='follow-up-chips']");
  assert.match(block, /flex-wrap:\s*wrap/, 'chips flow to the next line');
  assert.match(block, /overflow-x:\s*visible/, 'no scroll container');
  assert.match(block, /mask-image:\s*none/, 'no scroll fade affordance');
});

test('the transcript ends with a real spacer element sized to clear the composer', () => {
  assert.ok(
    chatView.includes('chat-transcript-end-spacer'),
    'chat-view.tsx renders the end-spacer element',
  );
  const blocks = blocksFor('.chat-transcript-end-spacer');
  for (const block of blocks)
    assert.match(block, /height:/, 'the spacer has real height, not padding');
  assert.ok(
    blocks.some((block) => block.includes('safe-area-inset-bottom')),
    'the phone spacer is safe-area aware',
  );
  assert.ok(
    blocks.some((block) => /210px/.test(block)),
    'the phone spacer clears the ~150-180px composer card',
  );
  // The spacer only renders with messages: the empty state's welcome stays centered.
  assert.ok(
    chatView.includes('messages.length > 0') && chatView.includes('chat-transcript-end-spacer'),
    'the spacer renders only when there are messages',
  );
});
