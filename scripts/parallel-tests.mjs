#!/usr/bin/env node
/**
 * Run test files in parallel shards on this machine.
 *
 * Why: the self-hosted runner is a single machine, so GitHub-level parallel
 * jobs just queue up. But the machine has multiple CPU cores — shard the test
 * files across parallel `node --test` processes instead.
 *
 * Usage:
 *   node scripts/parallel-tests.mjs [test-file ...]
 *   node scripts/parallel-tests.mjs --all
 *   node scripts/impacted-tests.mjs ... | node scripts/parallel-tests.mjs
 *
 * Input: test files as args, `--all` for the full suite, or a JSON array
 * (or one-per-line paths) on stdin — e.g. piped from impacted-tests.mjs.
 * An empty piped array is the full-suite signal (impacted-tests.mjs contract:
 * `[]` means "fall back to the full suite"), so it runs everything.
 * No input at all (interactive) also runs the full suite, same as `npm test`.
 *
 * Flags:
 *   --all               run every test in tests/*.test.mjs (same as `npm test`)
 *   --shards N          number of parallel shards (default: CPU cores)
 *   --fail-fast         kill remaining shards on the first shard failure
 *   --durations FILE    JSON { "tests/x.test.mjs": ms } for LPT sharding
 *   --timeout SECS      kill a shard that runs longer than SECS (0 = no limit).
 *                       Recommended in CI: one hung test file must not hang
 *                       the whole run (e.g. --timeout 600).
 *   --verbose           stream each shard's output live (default: summary only)
 *
 * Sharding: round-robin by default. With --durations, greedy longest-
 * processing-time (LPT) balancing: sort files by estimated duration desc,
 * assign each to the currently-lightest shard.
 *
 * Exit codes:
 *   0 - all shards passed
 *   1 - at least one shard failed (or no test files found)
 *   2 - usage error
 *
 * Fail-safe: any shard that crashes (non-zero exit without a test summary)
 * is reported as a shard error and fails the run.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toPosix = (p) => p.replace(/\\/g, '/');

const args = process.argv.slice(2);

function usage(exitCode = 2) {
  console.error(`Usage:
  node scripts/parallel-tests.mjs [test-file ...]
  node scripts/parallel-tests.mjs --all
  node scripts/impacted-tests.mjs ... | node scripts/parallel-tests.mjs

Flags:
  --all               all tests/*.test.mjs (same set as \`npm test\`)
  --shards N          parallel shards (default: ${availableParallelism()} CPU cores)
  --fail-fast         stop remaining shards on first failure
  --durations FILE    JSON durations for LPT sharding
  --timeout SECS      kill a shard that runs longer than SECS (0 = no limit)
  --verbose           stream shard output live`);
  process.exit(exitCode);
}

let shards = Math.max(1, availableParallelism());
let failFast = false;
let durationsFile = null;
let timeoutSecs = 0;
let verbose = false;
let runAll = false;
const files = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--all') runAll = true;
  else if (a === '--fail-fast') failFast = true;
  else if (a === '--verbose') verbose = true;
  else if (a === '--help' || a === '-h') usage(0);
  else if (a === '--shards') {
    const n = parseInt(args[++i], 10);
    if (!Number.isFinite(n) || n < 1) { console.error('--shards needs a positive integer'); usage(); }
    shards = n;
  } else if (a === '--timeout') {
    const n = parseInt(args[++i], 10);
    if (!Number.isFinite(n) || n < 0) { console.error('--timeout needs seconds >= 0'); usage(); }
    timeoutSecs = n;
  } else if (a === '--durations') {
    durationsFile = args[++i];
    if (!durationsFile) { console.error('--durations needs a file path'); usage(); }
  } else if (a.startsWith('--')) {
    console.error(`unknown flag: ${a}`); usage();
  } else {
    files.push(a);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return null;
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  data = data.trim();
  return data ? data : null;
}

function allTests() {
  return readdirSync(join(root, 'tests'))
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => toPosix(join('tests', f)))
    .sort();
}

function normalizeFile(f) {
  // Accept repo-relative or absolute paths; output repo-relative posix.
  const abs = resolve(root, f);
  if (!abs.startsWith(root + '/') && abs !== root) {
    console.error(`test file outside repo root: ${f}`);
    process.exit(2);
  }
  return toPosix(relative(root, abs));
}

async function main() {
  let testFiles = files.map(normalizeFile);
  let pipedInput = false; // true when stdin carried data (JSON array or lines)

  if (testFiles.length === 0 && !runAll) {
    const stdin = await readStdin();
    if (stdin) {
      pipedInput = true;
      try {
        const parsed = JSON.parse(stdin);
        if (!Array.isArray(parsed)) throw new Error('not an array');
        // Contract (matches impacted-tests.mjs): an empty array is the
        // full-suite signal -> fall back to running everything.
        testFiles = parsed.map((f) => normalizeFile(String(f)));
      } catch {
        // Fall back: one path per line.
        testFiles = stdin.split('\n').map((l) => l.trim()).filter(Boolean).map(normalizeFile);
      }
    }
  }

  if (runAll || testFiles.length === 0) {
    // --all, interactive TTY with no args, empty pipe, or `[]` full-suite
    // signal from impacted-tests: run the whole suite (same set as npm test).
    testFiles = allTests();
    if (!runAll && !pipedInput && process.stdin.isTTY) {
      console.log('parallel-tests: no input — running full suite (same as `npm test`)');
    }
  }

  // Verify files exist.
  const missing = testFiles.filter((f) => !existsSync(join(root, f)));
  if (missing.length) {
    console.error(`missing test files:\n  ${missing.join('\n  ')}`);
    process.exit(2);
  }

  const nShards = Math.min(shards, testFiles.length);
  console.log(`parallel-tests: ${testFiles.length} files across ${nShards} shard(s)`);

  // --- sharding -----------------------------------------------------------
  let durations = {};
  if (durationsFile) {
    try {
      durations = JSON.parse(readFileSync(resolve(root, durationsFile), 'utf8'));
    } catch (e) {
      console.error(`could not read durations file ${durationsFile}: ${e.message} — using round-robin`);
    }
  }

  const shardFiles = Array.from({ length: nShards }, () => []);
  const shardWeight = new Array(nShards).fill(0);
  const DEFAULT_MS = 2000;

  if (Object.keys(durations).length) {
    // Greedy LPT: longest first, each file goes to the lightest shard.
    const ordered = [...testFiles].sort(
      (a, b) => (durations[b] ?? DEFAULT_MS) - (durations[a] ?? DEFAULT_MS),
    );
    for (const f of ordered) {
      let lightest = 0;
      for (let s = 1; s < nShards; s++) if (shardWeight[s] < shardWeight[lightest]) lightest = s;
      shardFiles[lightest].push(f);
      shardWeight[lightest] += durations[f] ?? DEFAULT_MS;
    }
    console.log('parallel-tests: LPT sharding by estimated duration');
  } else {
    // Round-robin: deterministic, spreads alphabetically-adjacent files
    // (which often share fixtures) across shards.
    const ordered = [...testFiles].sort();
    ordered.forEach((f, i) => shardFiles[i % nShards].push(f));
  }

  // --- run shards ---------------------------------------------------------
  const startedAt = Date.now();

  const results = await Promise.all(
    shardFiles.map((sFiles, idx) => runShard(idx, nShards, sFiles, { failFast, verbose, timeoutSecs })),
  );

  // --- report -------------------------------------------------------------
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  let totalPass = 0, totalFail = 0, totalTests = 0, shardErrors = 0;
  console.log('\n═══ shard results ═══');
  for (const r of results) {
    totalPass += r.pass; totalFail += r.fail; totalTests += r.tests;
    if (r.error) shardErrors++;
    const status = r.error ? `ERROR: ${r.error}` : `${r.pass} pass, ${r.fail} fail`;
    console.log(`shard ${r.index + 1}/${nShards}: ${r.files} files, ${status} (${r.secs}s)`);
    for (const f of r.failedTests) console.log(`  ✖ [shard ${r.index + 1}] ${f}`);
  }
  console.log(`═══ total: ${totalTests} tests, ${totalPass} pass, ${totalFail} fail in ${elapsed}s (${nShards} shards) ═══`);

  // Print full output of failed shards for diagnosis.
  for (const r of results) {
    if ((r.fail > 0 || r.error) && !verbose) {
      console.log(`\n--- shard ${r.index + 1} output ---`);
      console.log(r.output.slice(-6000));
    }
  }

  process.exit(totalFail > 0 || shardErrors > 0 ? 1 : 0);
}

/**
 * Run one shard: `node --test <files...>`. Returns
 * { index, files, tests, pass, fail, secs, failedTests[], output, error? }.
 */
function runShard(index, nShards, sFiles, opts) {
  return new Promise((resolve) => {
    const label = `shard ${index + 1}/${nShards}`;
    if (opts.verbose) console.log(`[${label}] starting ${sFiles.length} files`);
    const start = Date.now();
    const child = spawn(process.execPath, ['--test', ...sFiles], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let output = '';
    child.stdout.on('data', (d) => {
      output += d;
      if (opts.verbose) process.stdout.write(`[s${index + 1}] ${d}`);
    });
    child.stderr.on('data', (d) => {
      output += d;
      if (opts.verbose) process.stderr.write(`[s${index + 1}] ${d}`);
    });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ index, files: sFiles.length, secs: ((Date.now() - start) / 1000).toFixed(1), output, ...result });
    };

    // Per-shard timeout: a hung test file must fail its shard, not hang CI.
    let timeout = null;
    if (opts.timeoutSecs > 0) {
      timeout = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ tests: 0, pass: 0, fail: 0, failedTests: [], error: `timed out after ${opts.timeoutSecs}s` });
      }, opts.timeoutSecs * 1000);
      timeout.unref?.();
    }

    if (opts.failFast) {
      const killer = setInterval(() => {
        if (globalThis.__parallelTestsAbort) {
          clearInterval(killer);
          child.kill('SIGTERM');
          finish({ tests: 0, pass: 0, fail: 0, failedTests: [], error: 'aborted by fail-fast' });
        }
      }, 200);
      child.on('exit', () => clearInterval(killer));
    }

    child.on('error', (e) => finish({ tests: 0, pass: 0, fail: 0, failedTests: [], error: `spawn failed: ${e.message}` }));
    child.on('exit', (code) => {
      const parsed = parseSummary(output);
      const failedTests = parseFailures(output);
      if (code !== 0 && opts.failFast && !globalThis.__parallelTestsAbort) {
        globalThis.__parallelTestsAbort = true;
        if (opts.verbose) console.log(`[${label}] failed — fail-fast: stopping other shards`);
      }
      if (!parsed) {
        finish({ tests: 0, pass: 0, fail: 0, failedTests, error: `exited ${code} with no test summary` });
      } else {
        finish({ tests: parsed.tests, pass: parsed.pass, fail: parsed.fail, failedTests });
      }
    });
  });
}

/** Parse the `ℹ tests/pass/fail` summary lines from node --test output. */
function parseSummary(output) {
  const num = (name) => {
    const m = output.match(new RegExp(`^ℹ ${name} (\\d+)`, 'm'));
    return m ? parseInt(m[1], 10) : null;
  };
  const tests = num('tests'), pass = num('pass'), fail = num('fail');
  if (tests === null || pass === null || fail === null) return null;
  return { tests, pass, fail };
}

/** Collect `✖` failing test lines (skips node's own "failing tests:" header). */
function parseFailures(output) {
  const seen = new Set();
  const out = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*✖\s+(.+?)\s*(\(\d[\d.,]*ms\))?\s*$/);
    if (!m || m[1].trim() === 'failing tests:') continue;
    const name = m[1].trim().slice(0, 160);
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

main().catch((e) => {
  console.error(`parallel-tests: ${e.message}`);
  process.exit(2);
});
