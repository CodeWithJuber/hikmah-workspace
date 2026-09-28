#!/usr/bin/env node
/**
 * Find test files impacted by changed source files.
 *
 * Usage:
 *   node scripts/impacted-tests.mjs [changed-file ...]
 *   node scripts/impacted-tests.mjs --from-git [<base-ref>]
 *   node scripts/impacted-tests.mjs --from-git-staged
 *
 * Output: JSON array of test file paths (relative to repo root), one per line
 *         when --lines is passed. Empty array (or full-suite signal) means
 *         "fall back to the full suite".
 *
 * Exit codes:
 *   0 - success, output is the impacted test list (may be empty = full suite)
 *   1 - error, caller should fall back to full suite
 *
 * Design: fast (<30s). Scans test files once, matches changed source paths
 * against import statements and esbuild entryPoints via substring matching
 * on normalized paths. Fail-safe: any error -> empty list -> full suite.
 *
 * Run: node scripts/impacted-tests.mjs --from-git origin/main
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toPosix = (p) => p.split(sep).join('/');

/** Test files live here (relative to repo root). */
const TEST_DIRS = ['tests', 'workbench/test'];

/** Changed files that always trigger the full suite. */
const FULL_SUITE_PATTERNS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^tsconfig.*\.json$/,
  /^\.github\//,
  /^drizzle\//,
  /^scripts\/impacted-tests\.mjs$/,
];

/** Style changes -> the style-discipline ratchet test. */
const STYLE_TEST = 'tests/style-discipline.test.mjs';
const STYLE_PATTERNS = [
  /\.css$/,
  /^app\/styles\//,
  // style-discipline scans components/ for icon sizes (size={n} ratchet)
  /^components\//,
];

/** Script checks -> the test that exercises them (best effort). */
const SCRIPT_CHECK_MAP = [
  [/scripts\/check-styles\.mjs$/, ['tests/style-discipline.test.mjs']],
  [/scripts\/check-reachable\.mjs$/, ['tests/reachability.test.mjs']],
  [/scripts\/build-design\.mjs$/, ['tests/style-discipline.test.mjs']],
];

function isTestFile(p) {
  const posix = toPosix(p);
  return (
    (posix.startsWith('tests/') || posix.startsWith('workbench/test/')) &&
    posix.endsWith('.test.mjs')
  );
}

function triggersFullSuite(p) {
  const posix = toPosix(p);
  return FULL_SUITE_PATTERNS.some((re) => re.test(posix));
}

function isStyleFile(p) {
  const posix = toPosix(p);
  return STYLE_PATTERNS.some((re) => re.test(posix));
}

function scriptCheckTests(p) {
  const posix = toPosix(p);
  const out = [];
  for (const [re, tests] of SCRIPT_CHECK_MAP) {
    if (re.test(posix)) out.push(...tests);
  }
  return out;
}

/** Recursively list files under dir (relative to repo root, posix). */
function listFiles(dir) {
  const out = [];
  const abs = join(root, dir);
  let entries;
  try {
    entries = readdirSync(abs);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(abs, name);
    const rel = toPosix(relative(root, full));
    try {
      if (statSync(full).isDirectory()) {
        out.push(...listFiles(rel));
      } else {
        out.push(rel);
      }
    } catch {
      // ignore unreadable entries
    }
  }
  return out;
}

/**
 * Normalize a changed path and an import specifier so they can be compared.
 * Strips leading ./ and ../ segments, query strings, and compares suffixes.
 */
function normalizePath(p) {
  return toPosix(p)
    .replace(/^(\.\/|\.\.\/)+/, '')
    .replace(/\?.*$/, '')
    .replace(/#.*$/, '');
}

/**
 * Extract candidate source references from a test file's text.
 * Catches: import ... from '...', entryPoints: [...], and bare path mentions.
 */
function extractRefs(text) {
  const refs = new Set();
  // import ... from 'path' / import 'path' / export ... from 'path'
  const importRe = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
  // entryPoints: ['path', ...]
  const entryRe = /entryPoints\s*:\s*\[([^\]]*)\]/g;
  // dynamic import('path')
  const dynRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  const collect = (re) => {
    while ((m = re.exec(text)) !== null) {
      // entryPoints capture group is the array body; split it
      const body = m[1];
      if (re === entryRe) {
        for (const part of body.split(',')) {
          const q = part.match(/['"]([^'"]+)['"]/);
          if (q) refs.add(normalizePath(q[1]));
        }
      } else {
        refs.add(normalizePath(body));
      }
    }
  };
  collect(importRe);
  collect(entryRe);
  collect(dynRe);
  return refs;
}

/**
 * Does a test file reference a changed source file?
 * Matches when any extracted ref ends with the changed path (suffix match),
 * or the changed path ends with the ref (handles extension differences like
 * .ts source vs bundled .mjs, and directory-level references).
 *
 * Note: pure basename matching is deliberately NOT done here — it causes
 * false positives (e.g. lib/chat/artifact.ts vs components/kernel/artifact.tsx
 * share the basename 'artifact' but are different files). The suffix match
 * with extension stripping covers the bundling case.
 */
function testReferences(testRefs, changedNorm) {
  const changedNoExt = changedNorm.replace(/\.(ts|tsx|js|mjs|mts|cts|json)$/, '');
  for (const ref of testRefs) {
    if (!ref || ref.startsWith('node:')) continue;
    const refNoExt = ref.replace(/\.(ts|tsx|js|mjs|mts|cts|json)$/, '');
    if (
      ref.endsWith(changedNorm) ||
      changedNorm.endsWith(ref) ||
      refNoExt.endsWith(changedNoExt) ||
      changedNoExt.endsWith(refNoExt)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Find source files that directly import the changed file (1-level reverse deps).
 * Used for transitive impact: if test bundles session.ts and session.ts imports
 * workspace-tools.ts, changing workspace-tools.ts impacts the test.
 */
function findReverseDeps(changedNorm, sourceFiles) {
  const reverse = new Set();
  const changedNoExt = changedNorm.replace(/\.(ts|tsx|js|mjs)$/, '');
  const changedBase = changedNoExt.split('/').pop();

  for (const srcFile of sourceFiles) {
    if (srcFile === changedNorm) continue;
    let text;
    try {
      text = readFileSync(join(root, srcFile), 'utf8');
    } catch {
      continue;
    }
    // Quick check: does this source mention the changed file?
    if (
      text.includes(changedNorm) ||
      text.includes(changedNoExt) ||
      (changedBase.length > 6 && text.includes(changedBase))
    ) {
      const refs = extractRefs(text);
      if (testReferences(refs, changedNorm)) {
        reverse.add(srcFile);
      }
    }
  }
  return reverse;
}

/** List all source files (for reverse-dep lookup). Cached per run. */
let _sourceFiles = null;
function getSourceFiles() {
  if (_sourceFiles) return _sourceFiles;
  _sourceFiles = [];
  const dirs = ['lib', 'server', 'components', 'app'];
  for (const dir of dirs) {
    for (const f of listFiles(dir)) {
      if (/\.(ts|tsx|js|mjs)$/.test(f) && !f.includes('.test.')) {
        _sourceFiles.push(f);
      }
    }
  }
  return _sourceFiles;
}

function getChangedFromGit(baseRef) {
  try {
    const out = execSync(`git diff --name-only ${baseRef}...HEAD`, {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
    });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function getChangedStaged() {
  try {
    const out = execSync('git diff --name-only --cached', {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
    });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const lines = args.includes('--lines');

  let changed;
  if (args.includes('--from-git-staged')) {
    changed = getChangedStaged();
  } else if (args.includes('--from-git')) {
    const idx = args.indexOf('--from-git');
    const base = args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : 'origin/main';
    changed = getChangedFromGit(base);
  } else {
    changed = args.filter((a) => !a.startsWith('--'));
  }

  if (!changed) {
    console.log(JSON.stringify([]));
    process.exit(0); // fail-safe: empty -> caller runs full suite
  }
  changed = [...new Set(changed.map((c) => toPosix(c)))].filter(Boolean);
  if (changed.length === 0) {
    console.log(JSON.stringify([]));
    process.exit(0);
  }

  // Any full-suite trigger -> empty list (caller falls back to full suite).
  if (changed.some(triggersFullSuite)) {
    console.log(JSON.stringify([]));
    process.exit(0);
  }

  const impacted = new Set();

  // 1. Changed test files run directly.
  for (const c of changed) {
    if (isTestFile(c)) impacted.add(c);
  }

  // 2. Style files -> style-discipline ratchet.
  if (changed.some(isStyleFile)) impacted.add(STYLE_TEST);

  // 3. Script checks -> their exercising tests.
  for (const c of changed) {
    for (const t of scriptCheckTests(c)) impacted.add(t);
  }

  // 4. Source files -> tests that reference them (direct + 1-level transitive).
  const sourceChanged = changed.filter(
    (c) => !isTestFile(c) && !isStyleFile(c) && scriptCheckTests(c).length === 0,
  );

  if (sourceChanged.length > 0) {
    // Expand with 1-level reverse deps (source files importing the changed file).
    const expanded = new Set(sourceChanged.map((c) => normalizePath(c)));
    const sourceFiles = getSourceFiles();
    for (const c of sourceChanged) {
      const norm = normalizePath(c);
      for (const rev of findReverseDeps(norm, sourceFiles)) {
        expanded.add(rev);
      }
    }

    const allTests = [];
    for (const dir of TEST_DIRS) {
      for (const f of listFiles(dir)) {
        if (f.endsWith('.test.mjs')) allTests.push(f);
      }
    }

    // Read each test once, extract refs, match against changed sources.
    for (const testFile of allTests) {
      if (impacted.has(testFile)) continue;
      let text;
      try {
        text = readFileSync(join(root, testFile), 'utf8');
      } catch {
        continue;
      }
      const refs = extractRefs(text);
      for (const norm of expanded) {
        if (testReferences(refs, norm)) {
          impacted.add(testFile);
          break;
        }
        const base = norm
          .split('/')
          .pop()
          .replace(/\.(ts|tsx|js|mjs)$/, '');
        if (base.length > 6 && text.includes(base)) {
          const dirPart = norm.split('/').slice(-2, -1)[0] || '';
          if (dirPart && text.includes(dirPart + '/' + base)) {
            impacted.add(testFile);
            break;
          }
        }
      }
    }
  }

  // Only keep test files that actually exist.
  const existing = [...impacted].filter((t) => {
    try {
      return statSync(join(root, t)).isFile();
    } catch {
      return false;
    }
  });

  existing.sort();
  if (lines) {
    for (const t of existing) console.log(t);
  } else {
    console.log(JSON.stringify(existing));
  }
}

try {
  main();
} catch (err) {
  // Fail-safe: any error -> empty list -> caller runs the full suite.
  console.error(`impacted-tests error: ${err && err.message}`);
  console.log(JSON.stringify([]));
  process.exit(0);
}
