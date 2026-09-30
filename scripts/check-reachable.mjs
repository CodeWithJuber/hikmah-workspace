#!/usr/bin/env node
/** What has no path to a route.
 *
 * Four features shipped, kept their screens, and reached no run: the co-model,
 * personal knowledge, shared knowledge and the workspace's own agents. Each
 * lost its only caller when the browser run loop was deleted, and each failed
 * silently — the setting stayed on screen and did nothing for weeks. They were
 * found one at a time, by the owner noticing an answer was wrong.
 *
 * That is not a process. This walks the import graph from the things the
 * runtime actually enters — routes, pages, instrumentation, the start script —
 * and reports exported values that nothing reachable imports.
 *
 * It is a heuristic, not a compiler: it reads import statements rather than
 * resolving a type graph. Everything it cannot see is listed in ALLOW below
 * with the reason, so the exceptions are read rather than guessed at.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = /\.(ts|tsx|mjs)$/;
const SKIP = new Set([
  'node_modules',
  '.next',
  '.git',
  'examples',
  'workbench',
  'public',
  'drizzle',
]);

/** Reached by the runtime without anyone importing them. */
const ENTRY = ['instrumentation.ts', 'scripts/start.mjs', 'scripts/setup.mjs', 'middleware.ts'];

/**
 * Not reachable by import, and deliberately so. Each line is a reason, not a
 * silencer: an entry that stops being true should be deleted, not kept.
 */
const ALLOW = [
  // Vendored shadcn and AI Elements: owned source, installed as a library, and
  // meant to have pieces this app does not use. Both are in .prettierignore for
  // the same reason.
  /^components\/ui\//,
  /^components\/ai-elements\//,
  // Loaded by URL as a worker bundle, never imported.
  /^lib\/playground\/sandbox\.worker\.ts$/,
  /^lib\/context-model\/train-worker\.ts$/,
  // Bundled by build-automatic-worker.mjs and launched in a Node worker thread.
  /^lib\/learning\/automatic-fit-worker\.ts$/,
  // Build inputs and one-shot operator scripts, not application code.
  /^scripts\//,
  // The design language. Compiled to app/styles/palette.generated.css by
  // `npm run design:build`; the CLI reads it, nothing imports it, and that is
  // the point — no Astryx code reaches the browser.
  /^design\//,
  // Test-only helpers live beside their tests.
  /^tests\//,
  // Pure helpers exported so unit tests can name them on purpose; each is
  // consumed by its own module's component/hook, which routes do render
  // (mobile-nav-bar in chat-shell + app-shell, useVisualViewport in the chat
  // composer). The check only counts cross-file uses, so these read as
  // tested-only — the feature is wired, the heuristic is coarse.
  // mobile-nav-bar.tsx: mobileNavTabs, mobileNavOverflow.
  /^components\/app\/mobile-nav-bar\.tsx$/,
  // use-visual-viewport.ts: readVisualViewport, bindVisualViewport.
  /^hooks\/use-visual-viewport\.ts$/,
  // Pure helpers exported so unit tests can name them on purpose; each is
  // consumed by its own module's component, which routes do render. The check
  // only counts cross-file uses, so these read as tested-only — the feature
  // is wired, the heuristic is coarse.
  // message-parts.tsx: ResearchSourceStrip, MiniFollowUpComposer — rendered in
  // isolation by tests, consumed by MessageParts in the same module (research
  // answer layout: query heading → source strip → cited answer → follow-ups).
  // access.ts: usageAlert — pure 80%/100% boundary helper tested in isolation;
  // billing-panel.tsx computes the same thresholds inline from its /api/billing
  // payload (different data shape: no Entitlements object client-side).
  /^components\/chat\/message-parts\.tsx$/,
  /^lib\/billing\/access\.ts$/,
  // breakpoints.ts: the canonical breakpoint ladder is a public API for
  // matchMedia / JS decisions (use-narrow.ts already consumes NARROW_QUERY;
  // maxQuery/minQuery/isPhoneViewport are the query builders the ladder
  // exists to serve). tests/breakpoints.test.mjs names them on purpose to
  // keep the ladder in sync with tokens.css — the feature is the ladder
  // itself, the heuristic is coarse.
  /^lib\/ui\/breakpoints\.ts$/,
  // mode.ts: chatModeFor is consumed by chat-view.tsx (free-mode pill); its
  // companion chatModeLabel is named by tests on purpose.
  /^lib\/chat\/mode\.ts$/,
  // drawer-focus.ts (PR-11): focusFirstInDrawer, handleDrawerKey and
  // pickReturnFocusTarget are consumed by chat-shell.tsx (the chat drawers);
  // focusableElements is named by tests on purpose to pin the tab order the
  // other three build on — the feature is wired, the heuristic is coarse.
  /^lib\/ui\/drawer-focus\.ts$/,
  // jev-client.ts: JEV_DEFAULT_TIMEOUT_MS is named by tests on purpose; the
  // timeout itself drives the Jev lane wait in the run pipeline.
  /^lib\/integrations\/jev-client\.ts$/,
  // v5 control layer (Phase 3, 2026-09-28): tested library modules staged for
  // Phase-4 agent-loop wiring. Budgets are stamped on every run via
  // enqueueRun() and visible in the run card; the feedback-recording and
  // enforcement callers are not yet in the run lifecycle — deliberate, because
  // enforcing ARM_CALL_CAP today would break working multi-tool runs.
  // Delete each entry when its caller lands, do not keep.
  // outcomes.ts: V_h outcome weighting + assertObserved for the policy loop.
  /^lib\/workflow\/outcomes\.ts$/,
  // procedures.ts: procedure DSL learner + promotion gate.
  /^lib\/workflow\/procedures\.ts$/,
  // dispatch.ts (PR-10): the arm dispatch service — every selectable arm's
  // declared steps + call cap through the PR-04 budget ledger. Tested at the
  // API boundary (tests/workflow-dispatch.test.mjs, 26 tests); the run-worker
  // caller lands with the agent-loop wiring, same staging as the entries above.
  /^lib\/workflow\/dispatch\.ts$/,
  // episode-annotations.ts: episode-solver bridge (approved-only annotations;
  // the solver itself is untouched and has no production caller yet).
  /^lib\/research\/episode-annotations\.ts$/,
  // Configuration and generated declarations. Read by the toolchain rather than
  // imported by the app, so "no route reaches this" is true and means nothing.
  // v10: db/schema.ts was deleted — it covered 17 of ~35 migrated tables with
  // zero indexes and had drifted from the SQL. The migrations in drizzle/ are
  // the single source of truth (sha256-pinned at apply time); a second,
  // wrong record of the schema is worse than none.
  /^next-env\.d\.ts$/,
  /\.config\.(ts|mjs|js)$/,
];

/**
 * The ratchet, in the shape check-styles.mjs already uses here.
 *
 * Zero is not the target and pretending otherwise would make the check
 * ignorable: 71 of these are constants and helpers a test names deliberately,
 * which is a reasonable thing for a test to do. What must not happen again is
 * the number *growing* unnoticed — `retrieveKnowledge`, `knowledgePrompt` and
 * the co-model's `analyzeContext` each sat in this list for weeks, proved by a
 * test and reaching no user, while their screens carried on offering the
 * setting. Lower one when you lower the file; `--update` records a drop.
 */
// testedOnly went 71 → 74 for three named on purpose by the chat-candidate
// tests: MIN_TOKENS and toAnnotation in lib/context-model/candidates.ts, and
// MAX_QUEUED in its store. Each is used inside its own module and exported so a
// test can assert against the constant rather than restate the number.
// 74 → 76 for two named on purpose by the deep-research tests:
// parseSubQuestions and isRateLimit in lib/ai/tools/deep-research.ts, the two
// pure rules the fan-out depends on (how a numbered plan is read, and what
// counts as the provider refusing on rate), each asserted directly rather than
// through a scripted model.
// 76 → 78 for two named by the provider tests: routeListingFor in
// lib/ai/pricing.ts (the id match a direct provider's price rests on) and
// resetRouteCatalogue in lib/server/route-catalogue.ts (the hour-long cache
// cannot be tested without a way to empty it).
// 79 → 82 and 44 → 47 for the Typeform integration: its client cursor/delay
// helpers and service constants are asserted directly by integration tests.
// (2026-09-29: Typeform removed entirely on the owner's decision — the whole
// integration, its routes, lib files and tests are gone, so the counts drop
// back: testedOnly 92 → 90, dead 50 → 48.)
// 82 → 91 and 47 → 50 for the Phase 3 v5 control layer (2026-09-28):
// the nine testedOnly are tuning constants and pure helpers the 78 new
// workflow tests name deliberately (DEFAULT_BUDGET, TERMINAL_STATES,
// validatePlan, agreement, createLedger, FEATURE_DIM, LAMBDA, LAMBDA_COST,
// LAMBDA_TIME) — the same "assert against the constant" pattern as above;
// the four dead-category additions are caps used inside their own modules and
// exported as the modules' public API for the Phase-4 agent-loop wiring
// (DECOMPOSE_MAX_LEAVES, DECOMPOSE_MAX_DEPTH, ALPHA, SPARSE_UPDATE_THRESHOLD).
// 91 → 92 for the Chat v2 keyboard shortcuts (2026-09-28): matchShortcut and
// isEditableTarget in lib/chat/shortcuts.ts are the pure rules
// useKeyboardShortcuts depends on (which chat-view.tsx wires to the real
// composer), asserted directly by the shortcut tests rather than through
// simulated DOM key events — the same "named on purpose" pattern.
// 90 → 93 for run telemetry (2026-09-29, PR-07): RUN_SEGMENTS and
// RUN_REASON_CODES are the fixed vocabularies the timeline and the client
// depend on, asserted directly by the telemetry tests rather than restated;
// isRunPhase and isRunReasonCode are the guards that keep unknown phase and
// reason strings off the progress UI, asserted directly. The two
// module-private constants (RUN_PHASES, TELEMETRY_BOOKKEEPING_PARTS) stay
// unexported so they add nothing to the dead count.
// 93 → 94 for the approval-card grant rules (2026-09-30, PR-13):
// grantOptions in components/chat/approval-card.tsx is the pure rule the
// "remember this yes" menu depends on (which grants an MCP tool may not be
// offered, which commands are grantable), asserted directly by the
// approval-card tests — a closed Radix menu renders nothing to static
// markup, so the options a card offers cannot be asserted through the DOM.
// 94 → 95 for the tool-permission dispatch (2026-09-30, PR-14):
// createToolDecider in lib/ai/run-agent.ts is the exported seam the policy
// tests name on purpose; it is wired — buildRunAgent calls it to build the
// agent's toolApproval — and the check only counts cross-file uses, so the
// export reads as tested-only while the feature is live.
// 95 → 97 for research grounding (2026-09-30, PR-19): parseClaims and
// detectContradictions in lib/ai/tools/deep-research.ts are the pure rules
// the contradiction display depends on (how SUPPORTS:/REFUTES: lines are
// read, and how opposing claims become one shown disagreement through
// PR-17's evaluateEvidence), each asserted directly rather than only through
// a scripted fan-out — the same "named on purpose" pattern as
// parseSubQuestions and isRateLimit above.
const BASELINE = { orphanFiles: 0, testedOnly: 97, dead: 48 };

async function walk(directory, out = []) {
  for (const entry of await readdir(join(ROOT, directory), { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const path = directory ? directory + '/' + entry.name : entry.name;
    if (entry.isDirectory()) await walk(path, out);
    else if (SOURCE.test(entry.name)) out.push(path);
  }
  return out;
}

/** Resolve one import specifier to a file in this repo, or null. */
function resolveImport(from, specifier) {
  let base;
  if (specifier.startsWith('@/')) base = join(ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(ROOT, dirname(from), specifier);
  else return null;
  for (const candidate of [
    base,
    base.replace(/\.js$/, '.ts'),
    base + '.ts',
    base + '.tsx',
    base + '.mjs',
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ])
    if (existsSync(candidate) && !candidate.endsWith('/')) return relative(ROOT, candidate);
  return null;
}

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

const files = await walk('');
const sources = new Map();
for (const file of files) sources.set(file, await readFile(join(ROOT, file), 'utf8'));

/** Every file the runtime can get to. */
const reachable = new Set();
const queue = [];
for (const file of files)
  // A route, page, layout or other App Router file is entered by the framework.
  if (
    /^app\/.*\/(route|page|layout|template|not-found|error|loading)\.tsx?$/.test(file) ||
    /^app\/(page|layout)\.tsx$/.test(file) ||
    ENTRY.includes(file)
  )
    queue.push(file);

const entryCount = queue.length;
while (queue.length) {
  const file = queue.pop();
  if (reachable.has(file) || !sources.has(file)) continue;
  reachable.add(file);
  const source = sources.get(file);
  for (const pattern of [IMPORT, DYNAMIC]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) {
      const target = resolveImport(file, match[1]);
      if (target && !reachable.has(target)) queue.push(target);
    }
  }
}

/** Exported values (not types), and who actually uses each. */
const EXPORTED = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

const testFiles = files.filter((file) => file.startsWith('tests/'));
const uses = (candidates, name, self) => {
  const word = new RegExp('\\b' + name + '\\b');
  return candidates.some((other) => other !== self && word.test(sources.get(other) ?? ''));
};

const dead = [];
const testedOnly = [];
for (const file of files) {
  if (ALLOW.some((rule) => rule.test(file))) continue;
  if (!reachable.has(file)) continue;
  const source = sources.get(file);
  EXPORTED.lastIndex = 0;
  let match;
  while ((match = EXPORTED.exec(source))) {
    const name = match[1];
    if (uses([...reachable], name, file)) continue;
    if (uses(testFiles, name, file)) testedOnly.push(`${file}  →  ${name}`);
    else dead.push(`${file}  →  ${name}`);
  }
}

const orphanFiles = files.filter(
  (file) => !reachable.has(file) && !ALLOW.some((rule) => rule.test(file)),
);

console.log(
  `reachability: ${entryCount} entry points, ${reachable.size}/${files.length} files reachable`,
);
if (orphanFiles.length) {
  console.log(`\n${orphanFiles.length} file(s) no route can reach:`);
  for (const file of orphanFiles) console.log('  ' + file);
}
// The interesting category, and the one this script exists for. An export with
// tests and no caller is a feature someone built, proved, and wired to nothing:
// retrieveKnowledge and the co-model's analyzeContext both looked exactly like
// this for weeks while their screens carried on offering the setting.
if (testedOnly.length) {
  console.log(
    `\n${testedOnly.length} export(s) that only tests use — proved, and reaching no user:`,
  );
  for (const row of testedOnly) console.log('  ' + row);
}
if (dead.length) {
  console.log(`\n${dead.length} export(s) nothing uses at all:`);
  for (const row of dead) console.log('  ' + row);
}
if (!orphanFiles.length && !testedOnly.length && !dead.length)
  console.log('\nnothing unreachable.');

const actual = {
  orphanFiles: orphanFiles.length,
  testedOnly: testedOnly.length,
  dead: dead.length,
};
const grown = Object.entries(BASELINE).filter(([key, limit]) => actual[key] > limit);
if (grown.length) {
  console.error('\nreachability moved in the wrong direction:\n');
  for (const [key, limit] of grown) console.error(`  ${key}: ${actual[key]}, was ${limit}`);
  console.error(
    [
      '',
      'Something new is exported and reaches no route. If it is a feature, wire',
      'it to one — a screen that offers a setting no run reads is the defect',
      'this check exists for. If it is a constant a test names on purpose, or a',
      'file the toolchain reads rather than imports, add it to ALLOW above with',
      'the reason, or raise the baseline in this file and say why in the commit.',
    ].join('\n'),
  );
  process.exit(1);
}

// Lowered by hand, so a refactor that improved things cannot quietly raise the
// ceiling again.
const slack = Object.entries(BASELINE).filter(([key, limit]) => actual[key] < limit);
if (slack.length && process.argv.includes('--update')) {
  const self = join(ROOT, 'scripts/check-reachable.mjs');
  writeFileSync(
    self,
    readFileSync(self, 'utf8').replace(
      /const BASELINE = \{[^}]*\};/,
      `const BASELINE = { orphanFiles: ${actual.orphanFiles}, testedOnly: ${actual.testedOnly}, dead: ${actual.dead} };`,
    ),
  );
  console.log('\nBaseline lowered to', actual);
} else if (slack.length) {
  console.log('\nbelow baseline; run with --update to lock it in');
}
