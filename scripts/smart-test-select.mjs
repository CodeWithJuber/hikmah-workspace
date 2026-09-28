#!/usr/bin/env node
/**
 * Smart test selection: decide WHICH tests to run for a set of changed files.
 *
 * This does NOT replace verification with guessing. Every tier still runs real,
 * deterministic checks. The intelligence is only in SELECTING the scope:
 *   cosmetic -> lint only (whitespace/comment/docs cannot break logic)
 *   low      -> impacted tests only (small, low-risk change)
 *   medium   -> impacted tests + typecheck (source changed, moderate blast radius)
 *   high     -> full suite (fail-safe: triggers, large radius, or any uncertainty)
 *
 * Layers (each optional except the deterministic core):
 *   1. Deterministic: full-suite triggers, git diff -w (cosmetic), docs-only,
 *      test-only changes. These are certain — no AI needed.
 *   2. forge impact: blast radius size (if `forge` is on PATH).
 *   3. LLM classification: behavioral vs refactor vs cosmetic (if
 *      OPENROUTER_API_KEY is set). Only used to DOWNGRADE risk when confident;
 *      never to skip verification.
 *   4. JEV risk judgment: for the ambiguous middle (if jev-ask is available).
 *      Uncertain -> more testing, never less.
 *
 * Usage:
 *   node scripts/smart-test-select.mjs [changed-file ...]
 *   node scripts/smart-test-select.mjs --from-git [<base-ref>]
 *   node scripts/smart-test-select.mjs --from-git-staged
 *
 * Output: JSON { tier, tests, reason, signals }.
 * Exit 0 always on success; any error -> tier "high" (fail-safe to full suite).
 *
 * Honesty invariants:
 *   - AI never says "tests will pass". It only says "this change looks
 *     low-risk; run the smaller set". The smaller set still runs for real.
 *   - Any uncertainty at any layer -> tier escalates, never de-escalates.
 *   - Main-branch pushes should always use the full suite; this tool is for
 *     PRs and the local pre-push gate.
 */
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toPosix = (p) => p.split('/').join('/');

/** Changed files that always trigger the full suite. */
const FULL_SUITE_PATTERNS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^tsconfig.*\.json$/,
  /^\.github\//,
  /^drizzle\//,
  /^scripts\/(impacted-tests|smart-test-select)\.mjs$/,
];

/** File types that can never break logic. */
const DOC_PATTERNS = [/\.md$/, /\.txt$/, /^\.forge\//, /^docs\//];

/** Blast radius above this -> medium/high regardless of classification. */
const LARGE_BLAST_RADIUS = 10;
/** Blast radius at or below this -> candidate for low tier. */
const SMALL_BLAST_RADIUS = 3;

function sh(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      cwd: root,
      encoding: 'utf8',
      timeout: opts.timeout || 30000,
      stdio: opts.stdio || 'pipe',
    }).trim();
  } catch {
    return null;
  }
}

function getChanged(args) {
  if (args.includes('--from-git-staged')) {
    const out = sh('git diff --name-only --cached');
    return out
      ? out
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
  }
  if (args.includes('--from-git')) {
    const idx = args.indexOf('--from-git');
    const base = args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : 'origin/main';
    const out = sh(`git diff --name-only ${base}...HEAD`);
    return out
      ? out
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
  }
  return args.filter((a) => !a.startsWith('--'));
}

/** True if the diff, ignoring whitespace, is empty -> cosmetic change. */
function isCosmeticDiff(changed) {
  // git diff -w ignores whitespace; if nothing remains, only whitespace changed.
  // We also treat pure comment changes as cosmetic via a heuristic below.
  const out = sh(
    'git diff -w --ignore-blank-lines --cached -- . 2>/dev/null || git diff -w --ignore-blank-lines -- .',
  );
  if (out === null) return false;
  if (out.trim() === '') return true;
  // Heuristic: diff lines that are all comments (//, /*, *, #, <!--) or blank.
  const lines = out.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-'));
  const content = lines.filter((l) => !l.startsWith('+++') && !l.startsWith('---'));
  if (content.length === 0) return true;
  const commentRe = /^[+-]\s*(\/\/|\/\*|\*|#|<!--|$)/;
  return content.every((l) => commentRe.test(l));
}

function triggersFullSuite(changed) {
  return changed.some((c) => FULL_SUITE_PATTERNS.some((re) => re.test(toPosix(c))));
}

function isDocsOnly(changed) {
  return changed.length > 0 && changed.every((c) => DOC_PATTERNS.some((re) => re.test(toPosix(c))));
}

function isTestOnly(changed) {
  return changed.length > 0 && changed.every((c) => /(\.test\.|__tests__)/.test(toPosix(c)));
}

/** Blast radius via `forge impact --json`. Returns file count or null. */
function blastRadius(changed) {
  const forge = sh('command -v forge');
  if (!forge) return null;
  let total = 0;
  for (const f of changed.slice(0, 10)) {
    // Limit to 10 files to keep it fast.
    const out = sh(`forge impact ${JSON.stringify(f)} --json 2>/dev/null`, {
      timeout: 15000,
    });
    if (!out) return null;
    try {
      const data = JSON.parse(out);
      const files = data.impactedFiles || data.impacted || [];
      total += Array.isArray(files) ? files.length : 0;
    } catch {
      return null;
    }
  }
  return total;
}

/**
 * Classify the change with a small free OpenRouter model via the openrouter-chat CLI
 * (uses the stored custom.openrouter credential — never an env var).
 * Returns 'behavioral' | 'refactor' | 'cosmetic' | 'config' | null (unavailable/uncertain).
 * Only used to DOWNGRADE risk when confident; null -> no downgrade.
 */
async function llmClassify(changed, diffSample) {
  const { writeFileSync, unlinkSync, readFileSync, existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');

  // Find the CLI: check multiple locations, skip gracefully if not found.
  // In CI, the CLI won't exist — that's fine, the LLM layer is optional.
  const candidates = [
    process.env.HOME + '/workspace/skills/openrouter/bin/openrouter-chat',
    new URL('../../../skills/openrouter/bin/openrouter-chat', import.meta.url).pathname,
  ];
  const cli = candidates.find((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
  if (!cli) return null; // LLM unavailable — deterministic core handles it

  const prompt = `Classify this code change. Changed files: ${changed.slice(0, 15).join(', ')}.
Diff sample (first 40 lines):
${diffSample.split('\n').slice(0, 40).join('\n')}
Reply with exactly one word: behavioral, refactor, cosmetic, or config.
- behavioral: logic, control flow, or data handling changed
- refactor: code restructured but behavior preserved (renames, moves, extraction)
- cosmetic: comments, formatting, whitespace only
- config: config files, dependencies, CI (not application logic)`;
  // Write prompt to a temp file to avoid shell-quoting issues.
  const tmp = `/tmp/smart-select-prompt-${process.pid}.txt`;
  try {
    writeFileSync(tmp, prompt);
    const promptText = readFileSync(tmp, 'utf8');
    let out = null;
    try {
      out = execFileSync(cli, ['--prompt', promptText, '--max-tokens', '100'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60000,
        stdio: 'pipe',
      }).trim();
    } catch {
      out = null;
    }
    try {
      unlinkSync(tmp);
    } catch {}
    if (!out) return null;
    // Robust parse: find the first category word in the output (models may be verbose).
    const lower = out.toLowerCase();
    for (const cat of ['behavioral', 'refactor', 'cosmetic', 'config']) {
      if (lower.includes(cat)) return cat;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ask JEV for a risk judgment on running reduced tests.
 * Returns probability (0-1) that reduced testing is SAFE, or null if unavailable.
 * Low probability / uncertain -> escalate tier (more testing, never less).
 */
function jevRisk(changed, blast, classification) {
  const jev = sh('command -v jev-ask');
  if (!jev) return null;
  const state = JSON.stringify({
    files_changed: changed.length,
    blast_radius: blast,
    classification: classification || 'unknown',
  });
  const out = sh(
    `jev-ask --prompt ${JSON.stringify(
      `A change touches ${changed.length} files (blast radius ~${blast ?? 'unknown'}, classified as ${classification || 'unknown'}). Is it safe to run only the impacted tests instead of the full suite?`,
    )} --type noul --state ${JSON.stringify(state)} 2>/dev/null`,
    { timeout: 30000 },
  );
  if (!out) return null;
  const m = out.match(/probability:\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

/** Get impacted tests via the existing deterministic script. */
function impactedTests(changed) {
  const out = sh(
    `node scripts/impacted-tests.mjs ${changed.map((c) => JSON.stringify(c)).join(' ')} 2>/dev/null`,
    { timeout: 60000 },
  );
  if (out === null) return null;
  try {
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const failSafe = (reason) => {
    console.log(JSON.stringify({ tier: 'high', tests: [], reason, signals: {} }, null, 2));
  };

  let changed = getChanged(args);
  if (!changed) return failSafe('could not determine changed files');
  changed = [...new Set(changed.map(toPosix))].filter(Boolean);
  if (changed.length === 0) return failSafe('no changed files');

  const signals = {};

  // Layer 1: deterministic — full-suite triggers.
  if (triggersFullSuite(changed)) {
    return console.log(
      JSON.stringify(
        {
          tier: 'high',
          tests: [],
          reason: 'full-suite trigger file changed (package.json, .github/, etc.)',
          signals: { fullSuiteTrigger: true },
        },
        null,
        2,
      ),
    );
  }

  // Layer 1: deterministic — docs-only.
  if (isDocsOnly(changed)) {
    return console.log(
      JSON.stringify(
        {
          tier: 'cosmetic',
          tests: [],
          reason: 'docs/markdown only — cannot break logic',
          signals: { docsOnly: true },
        },
        null,
        2,
      ),
    );
  }

  // Layer 1: deterministic — cosmetic diff (whitespace/comments).
  if (isCosmeticDiff(changed)) {
    signals.cosmeticDiff = true;
    return console.log(
      JSON.stringify(
        {
          tier: 'cosmetic',
          tests: [],
          reason: 'whitespace/comment-only diff — cannot break logic',
          signals,
        },
        null,
        2,
      ),
    );
  }

  // Layer 1: deterministic — test-only changes.
  const tests = impactedTests(changed);
  if (tests === null) return failSafe('impacted-tests script failed');
  if (isTestOnly(changed)) {
    return console.log(
      JSON.stringify(
        {
          tier: 'low',
          tests,
          reason: 'only test files changed — run them directly',
          signals: { testOnly: true },
        },
        null,
        2,
      ),
    );
  }

  // Layer 2: blast radius via forge impact (optional).
  const blast = blastRadius(changed);
  signals.blastRadius = blast;
  if (blast !== null && blast > LARGE_BLAST_RADIUS) {
    return console.log(
      JSON.stringify(
        {
          tier: 'medium',
          tests,
          reason: `large blast radius (${blast} files) — impacted tests + typecheck`,
          signals,
        },
        null,
        2,
      ),
    );
  }

  // Layer 3: LLM classification (optional, only downgrades on confident refactor/cosmetic).
  const diffSample =
    sh('git diff --cached -- . 2>/dev/null | head -100') ||
    sh('git diff -- . 2>/dev/null | head -100') ||
    '';
  const classification = await llmClassify(changed, diffSample);
  signals.llmClassification = classification;

  // Layer 4: JEV risk judgment for the ambiguous middle (optional).
  const risk = jevRisk(changed, blast, classification);
  signals.jevRisk = risk;

  // Decision: escalate on any uncertainty, never de-escalate.
  let tier = 'medium';
  let reason = 'source changed — impacted tests + typecheck (default)';

  if (blast !== null && blast <= SMALL_BLAST_RADIUS) {
    if (classification === 'refactor' || classification === 'cosmetic') {
      // LLM confident it's behavior-preserving + small radius.
      // JEV gets a vote: only downgrade if JEV is also confident.
      if (risk !== null && risk >= 0.7) {
        tier = 'low';
        reason = `small blast radius (${blast}), LLM: ${classification}, JEV risk ${risk.toFixed(2)} — impacted tests only`;
      } else {
        reason = `small blast radius (${blast}), LLM: ${classification}, JEV uncertain (${risk ?? 'n/a'}) — keeping medium`;
      }
    } else if (risk !== null && risk >= 0.8) {
      // JEV very confident despite unknown classification.
      tier = 'low';
      reason = `small blast radius (${blast}), JEV risk ${risk.toFixed(2)} — impacted tests only`;
    }
  }

  // Empty impacted list with source changes -> medium is wrong; escalate to high.
  // (impacted-tests returns [] on full-suite triggers, already handled above,
  // but an empty result with real source changes means the matcher found
  // nothing — safer to run the full suite than to run zero tests.)
  if (tests.length === 0) {
    tier = 'high';
    reason = 'source changed but no impacted tests matched — fail-safe to full suite';
  }

  console.log(JSON.stringify({ tier, tests, reason, signals }, null, 2));
}

main().catch(() => {
  console.log(
    JSON.stringify(
      { tier: 'high', tests: [], reason: 'exception — fail-safe', signals: {} },
      null,
      2,
    ),
  );
});
