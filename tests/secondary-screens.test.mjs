// Phase 2B: the secondary screens wear the native layer too — labs list +
// lab detail, the settings hub + settings tabs, billing and pricing. Static
// checks over the source: tap targets, the four states, the icon scale, and
// no emoji. The other half is a device and an eye.
// Run: node --test tests/secondary-screens.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const ui = strip(readFileSync(resolve(root, 'app/styles/native-ui.css'), 'utf8'));
const billingCss = strip(readFileSync(resolve(root, 'app/styles/billing.css'), 'utf8'));

const read = (p) => readFileSync(resolve(root, p), 'utf8');
const labsPage = read('components/app/labs-page.tsx');
const labsLoading = read('app/(app)/labs/loading.tsx');
const labDetail = read('app/(app)/labs/[id]/page.tsx');
const labDetailLoading = read('app/(app)/labs/[id]/loading.tsx');
const settingsHub = read('components/app/settings-page.tsx');
const admin = read('components/playground/admin.tsx');
const adminLoading = read('app/(app)/settings/[tab]/loading.tsx');
const billing = read('components/billing/billing-panel.tsx');
const checkoutBtn = read('components/billing/plan-checkout-button.tsx');
const pricing = read('app/pricing/page.tsx');

const SOURCES = {
  'labs-page.tsx': labsPage,
  'labs/loading.tsx': labsLoading,
  'labs/[id]/page.tsx': labDetail,
  'labs/[id]/loading.tsx': labDetailLoading,
  'settings-page.tsx': settingsHub,
  'admin.tsx': admin,
  'settings/[tab]/loading.tsx': adminLoading,
  'billing-panel.tsx': billing,
  'plan-checkout-button.tsx': checkoutBtn,
  'pricing/page.tsx': pricing,
};

/** Class -> guaranteed minimum tap dimension (px), from native-ui.css. */
const TARGETS = {
  'n-row': 68, // the whole row is the link
  'n-icon-btn': 44,
  'n-cta': 48,
  'n-chip': 40, // Jev bump-40 precedent
  'n-card-icon': 44, // the fixed tile inside a card
};

function cssMinHeight(css, cls) {
  const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').some((sel) => sel.trim() === `.${cls}`))
    .map((m) => m[2]);
  assert.ok(bodies.length > 0, `.${cls} must be defined in native-ui.css`);
  const dims = [];
  for (const body of bodies)
    for (const m of body.matchAll(/(?:min-)?(?:height|width):\s*([\d.]+)px/g))
      dims.push(Number(m[1]));
  assert.ok(dims.length > 0, `.${cls} must pin a px dimension`);
  return Math.min(...dims);
}

test('the target classes guarantee the sizes the test names', () => {
  for (const [cls, want] of Object.entries(TARGETS))
    assert.equal(cssMinHeight(ui, cls), want, `.${cls} must guarantee ${want}px`);
});

test('labs list: cards in the shared grid, staggered, labelled', () => {
  assert.ok(labsPage.includes('className="n-card-grid n-stagger"'), 'card grid + stagger');
  assert.ok(labsPage.includes('className="n-card n-press"'), 'pressable cards');
  assert.ok(labsPage.includes('n-card-icon'), 'icon tile');
  assert.ok(labsPage.includes('n-card-title'), 'card title');
  assert.ok(labsPage.includes("router.push('/labs/' + l.id)"), 'cards route to the lab');
  assert.ok(labsPage.includes('aria-label={`${l.name}'), 'cards announce themselves');
  assert.ok(labsPage.includes("'--i': i"), 'stagger index per card');
  assert.ok(!labsPage.includes('sections.module.css'), 'off the old section styles');
  assert.ok(labsLoading.includes('n-shimmer-line'), 'skeleton loading state');
  assert.ok(!labsLoading.includes('Skeleton'), 'no Tailwind skeleton');
});

test('lab detail: sticky header with back, then the lab itself', () => {
  assert.ok(labDetail.includes('className="n-header"'), 'native header');
  assert.ok(labDetail.includes('className="n-icon-btn n-press"'), 'back is a 44px target');
  assert.ok(labDetail.includes('aria-label="All labs"'), 'back is labelled');
  assert.ok(labDetail.includes('<h1>{lab.name}</h1>'), 'the lab names the screen');
  assert.ok(labDetail.includes('MeaningLab'), 'lab bodies untouched');
  assert.ok(!labDetail.includes('sections.module.css'), 'off the old section styles');
  assert.ok(labDetailLoading.includes('n-shimmer-line'), 'skeleton loading state');
});

test('settings hub: section signposts and 68px rows', () => {
  assert.ok(settingsHub.includes('className="n-header"'), 'native header');
  const sections = [...settingsHub.matchAll(/className="n-section-title"/g)].length;
  assert.equal(sections, 1, 'one n-section-title per group is rendered in a loop');
  assert.ok(settingsHub.includes("'Workspace'"), 'Workspace group');
  assert.ok(settingsHub.includes("'Memory'"), 'Memory group');
  assert.ok(settingsHub.includes("'Advanced'"), 'Advanced group');
  assert.ok(settingsHub.includes('className="n-list n-stagger"'), 'lists stagger');
  assert.ok(settingsHub.includes('className="n-row n-press-tint"'), 'rows press with tint');
  assert.ok(settingsHub.includes('n-row-avatar'), 'icon tile');
  assert.ok(settingsHub.includes('n-row-title'), 'row title');
  assert.ok(settingsHub.includes('n-row-snippet'), 'row snippet');
  assert.ok(settingsHub.includes('<ChevronRight size={20}'), 'chevron on the icon scale');
  assert.ok(!settingsHub.includes('sections.module.css'), 'off the old section styles');
});

test('settings tabs: native shell, chip tab row, animated panels', () => {
  assert.ok(admin.includes('className="n-page n-screen-in"'), 'native page shell');
  assert.ok(admin.includes('<h1>Workspace settings</h1>'), 'screen title');
  assert.ok(admin.includes('aria-label="Back to chat"'), 'back is labelled');
  assert.ok(admin.includes('role="tablist"'), 'chip row is a tablist');
  assert.ok(admin.includes("className={'n-chip n-press'"), 'chips press');
  assert.ok(admin.includes('aria-selected={tab === value}'), 'selection is announced');
  assert.equal(
    (
      admin.match(/'overview', 'providers', 'media', 'connectors', 'secrets', 'skills', 'plan'/g) ??
      []
    ).length,
    1,
    'all seven tabs',
  );
  assert.ok(admin.includes('className="n-tab-panel"'), 'panels cross-fade');
  assert.ok(!admin.includes('TabsList'), 'shadcn tab chrome is gone');
  assert.ok(!admin.includes('<Skeleton'), 'plan skeleton is native');
  assert.ok(adminLoading.includes('n-shimmer-line'), 'tab loading skeleton');
});

test('settings overview: shortcuts are native rows', () => {
  assert.ok(admin.includes('aria-label="Settings shortcuts"'), 'shortcut list is labelled');
  const rows = (admin.match(/className="n-row n-press-tint"/g) ?? []).length;
  assert.equal(rows, 7, `7 shortcut rows, got ${rows}`);
  assert.ok(admin.includes('<ArrowRight size={20}'), 'row chevrons on the icon scale');
});

test('settings empty states are never dead ends', () => {
  assert.ok(admin.includes('className="n-empty"'), 'native empty state');
  assert.ok(admin.includes('<h2>Connect your first tool server</h2>'), 'connectors empty title');
  assert.ok(admin.includes('<h2>No skills yet</h2>'), 'skills empty title');
  assert.ok(admin.includes('className="n-cta n-press"'), 'empty states carry a CTA');
  assert.ok(admin.includes('Add server'), 'connectors empty state gained its missing next step');
  assert.ok(admin.includes('New skill'), 'skills empty state keeps its next step');
});

test('billing: native header, card-grid plans, the four states', () => {
  assert.ok(billing.includes('className="n-header"'), 'native header');
  assert.ok(billing.includes('aria-label="Back to your workspace"'), 'back is labelled');
  assert.ok(billing.includes('<h1>Plan and usage</h1>'), 'screen title');
  assert.ok(billing.includes('className="n-card-grid n-stagger"'), 'plans use the card grid');
  assert.ok(billing.includes('billing-plan'), 'plan cards keep their billing rules');
  assert.ok(billing.includes("'--i': i"), 'plan cards stagger');
  // Loading.
  assert.ok(billing.includes('n-shimmer-line'), 'skeleton loading state');
  assert.ok(!billing.includes("from '@/components/ui/skeleton'"), 'no Tailwind skeleton');
  // Error, no data: named problem + retry.
  assert.ok(billing.includes('className="n-error"'), 'full-page error state');
  assert.ok(billing.includes('role="alert"'), 'error is announced');
  assert.ok(billing.includes('Try again'), 'error offers retry');
  // Error with data: inline alert + retry.
  assert.ok(billing.includes('className="billing-inline-error"'), 'inline error block');
  // Buttons answer the finger.
  assert.ok(billing.includes('className="n-press"'), 'plan buttons press');
});

test('billing buttons clear the 44px tap floor', () => {
  const m = /\.billing-current button,\s*\.billing-plan button\s*\{[^}]*min-height:\s*(\d+)px/.exec(
    billingCss,
  );
  assert.ok(m, 'the plan-button rule must pin a min-height');
  assert.ok(Number(m[1]) >= 44, `plan buttons must be >= 44px, got ${m[1]}px`);
  assert.ok(billingCss.includes('.billing-notice-actions button'), 'notice actions are sized');
});

test('pricing keeps its marketing design, gains the stagger', () => {
  assert.ok(pricing.includes('landing-plans n-stagger'), 'plans walk in');
  assert.ok(pricing.includes("'--i': i"), 'stagger index per plan');
  assert.ok(pricing.includes('is-featured'), 'featured card kept');
  assert.ok(checkoutBtn.includes('role="alert"'), 'checkout errors are announced');
  assert.ok(checkoutBtn.includes('className="landing-primary"'), 'CTA keeps its marketing style');
});

test('no new layout breakpoints in the touched styles', () => {
  const widths = new Set();
  for (const [query] of billingCss.matchAll(/@media([^{]*)\{/g))
    for (const [, kind, size] of query.matchAll(/(min|max)-width:\s*(\d+)px/g))
      widths.add(kind === 'max' ? Number(size) + 1 : Number(size));
  assert.deepEqual([...widths], [], 'billing.css must add no @media widths');
});

test('icons stay on the 12/16/20/24/32/48 scale', () => {
  const SCALE = new Set([12, 16, 20, 24, 32, 48]);
  const off = [];
  for (const [name, src] of Object.entries(SOURCES))
    for (const [, size] of src.matchAll(/size=\{(\d+)\}/g))
      if (!SCALE.has(Number(size))) off.push(`${name} size={${size}}`);
  assert.deepEqual(off, [], 'icon sizes outside the scale');
});

test('no emoji anywhere near the secondary screens', () => {
  const emoji = /\p{Extended_Pictographic}/u;
  const bad = Object.entries(SOURCES)
    .filter(([, src]) => emoji.test(src))
    .map(([name]) => name);
  assert.deepEqual(bad, [], 'emoji found in: ' + bad.join(', '));
});

test('the touched CSS stays token-driven where it was pinned', () => {
  // billing.css is pinned (colour/type/radius) by style-discipline.test.mjs;
  // this guards the rules this phase touched.
  const touched = ['.billing-notice-actions button', '.billing-inline-error'];
  for (const sel of touched)
    assert.ok(billingCss.includes(sel), `${sel} must exist in billing.css`);
  const literalColour = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(billingCss);
  assert.ok(!literalColour, 'billing.css must name no colour literally');
});
