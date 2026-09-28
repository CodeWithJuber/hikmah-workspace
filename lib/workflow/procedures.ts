/**
 * lib/workflow/procedures.ts — Bounded procedure learner (phase3-spec §3.4,
 * docs/v5/research.md §5 "bounded program induction").
 *
 * A tiny allowlisted DSL over JSON-ish values. Procedures are enumerated from
 * templates, tested against examples, pruned by counterexamples, and ranked
 * by the J(p) objective:
 *
 *   J(p) = accuracy(p) − λ_size · |p|
 *
 * i.e. among procedures that explain the examples, prefer the shortest.
 * Execution is bounded (step cap) so a promoted procedure always terminates.
 *
 * Promotion requires the dev-gate discipline. This module does NOT import
 * lib/context-model and does NOT invent new gates: the caller injects
 * `gateCheck: () => boolean`, which must run the existing frozen gate
 * machinery (no per-sentence regression, stale-activation rejection). A
 * procedure whose gate check fails is refused promotion. Promoted procedures
 * become eligible for the `local` arm — see isProcedureEligible().
 *
 * Pure logic — the promoted-procedure registry is module-local; persistence
 * (if needed) is another worker's concern.
 */

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// The allowlisted DSL.
// ---------------------------------------------------------------------------

export type DslPredicate =
  | { kind: 'eq'; path: string; value: JsonValue }
  | { kind: 'gt'; path: string; value: number }
  | { kind: 'lt'; path: string; value: number }
  | { kind: 'contains'; path: string; value: string }
  | { kind: 'exists'; path: string };

export type DslOp =
  | { op: 'get'; path: string }
  | { op: 'filter'; where: DslPredicate }
  | { op: 'project'; paths: string[] }
  | { op: 'count' }
  | { op: 'sum'; path: string }
  | { op: 'mean'; path: string }
  | { op: 'first' };

export interface Procedure {
  id: string;
  ops: DslOp[];
}

/** λ_size in J(p) = accuracy(p) − λ_size·|p|. Small: correctness dominates. */
export const PROCEDURE_SIZE_PENALTY = 0.01;

/** Default bound on interpreter steps (ops + per-element work). */
export const PROCEDURE_MAX_STEPS = 10000;

/**
 * J(p): the procedure objective. accuracy ∈ [0,1], size = number of ops.
 * Higher is better; among equally accurate procedures the shorter wins.
 */
export function procedureObjective(accuracy: number, size: number): number {
  return accuracy - PROCEDURE_SIZE_PENALTY * size;
}

// ---------------------------------------------------------------------------
// Interpreter (bounded).
// ---------------------------------------------------------------------------

function getPath(value: JsonValue, path: string): JsonValue | undefined {
  let cur: JsonValue | undefined = value;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined;
      cur = cur[i];
    } else if (typeof cur === 'object') {
      cur = (cur as { [k: string]: JsonValue })[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, (b as JsonValue[])[i]));
  }
  if (typeof a === 'object') {
    const ao = a as { [k: string]: JsonValue };
    const bo = b as { [k: string]: JsonValue };
    const ka = Object.keys(ao);
    const kb = Object.keys(bo);
    return ka.length === kb.length && ka.every((k) => deepEqual(ao[k], bo[k]));
  }
  return false;
}

function testPredicate(item: JsonValue, pred: DslPredicate): boolean {
  const v = getPath(item, pred.path);
  switch (pred.kind) {
    case 'eq':
      return deepEqual(v, pred.value);
    case 'gt':
      return typeof v === 'number' && v > pred.value;
    case 'lt':
      return typeof v === 'number' && v < pred.value;
    case 'contains':
      return typeof v === 'string' && v.includes(pred.value);
    case 'exists':
      return v !== undefined;
  }
}

function leafKey(path: string): string {
  const segs = path.split('.');
  return segs[segs.length - 1];
}

/** Thrown when a procedure exceeds its step budget — never hangs. */
export class ProcedureStepError extends Error {
  constructor(id: string, steps: number) {
    super(`procedure '${id}' exceeded step budget (${steps})`);
    this.name = 'ProcedureStepError';
  }
}

function numbersAt(items: JsonValue[], path: string): number[] {
  const out: number[] = [];
  for (const item of items) {
    const v = getPath(item, path);
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

function applyOp(
  op: DslOp,
  value: JsonValue,
  counter: { steps: number },
  procId: string,
): JsonValue {
  const tick = (n = 1): void => {
    counter.steps += n;
    if (counter.steps > PROCEDURE_MAX_STEPS) throw new ProcedureStepError(procId, counter.steps);
  };
  tick();
  switch (op.op) {
    case 'get': {
      const v = getPath(value, op.path);
      if (v === undefined) throw new Error(`get: path '${op.path}' not found`);
      return v;
    }
    case 'filter': {
      if (!Array.isArray(value)) throw new Error('filter: input is not an array');
      tick(value.length);
      return value.filter((item) => testPredicate(item, op.where));
    }
    case 'project': {
      const projectOne = (item: JsonValue): JsonValue => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
        const out: { [k: string]: JsonValue } = {};
        for (const p of op.paths) {
          const v = getPath(item, p);
          if (v !== undefined) out[leafKey(p)] = v;
        }
        return out;
      };
      if (Array.isArray(value)) {
        tick(value.length);
        return value.map(projectOne);
      }
      return projectOne(value);
    }
    case 'count': {
      if (!Array.isArray(value)) throw new Error('count: input is not an array');
      return value.length;
    }
    case 'sum': {
      if (!Array.isArray(value)) throw new Error('sum: input is not an array');
      tick(value.length);
      return numbersAt(value, op.path).reduce((s, n) => s + n, 0);
    }
    case 'mean': {
      if (!Array.isArray(value)) throw new Error('mean: input is not an array');
      tick(value.length);
      const nums = numbersAt(value, op.path);
      // Mean of no numeric values is 0 by convention (documented, deterministic).
      return nums.length === 0 ? 0 : nums.reduce((s, n) => s + n, 0) / nums.length;
    }
    case 'first': {
      if (!Array.isArray(value)) throw new Error('first: input is not an array');
      return value.length === 0 ? null : value[0];
    }
  }
}

/**
 * Run a procedure on an input value. Bounded: throws ProcedureStepError if
 * the step budget is exceeded, Error on type errors (e.g. filter on a
 * non-array). Pure and terminating.
 */
export function runProcedure(p: Procedure, input: JsonValue): JsonValue {
  const counter = { steps: 0 };
  let value = input;
  for (const op of p.ops) {
    value = applyOp(op, value, counter, p.id);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Test / enumerate / prune.
// ---------------------------------------------------------------------------

export interface ProcedureExample {
  input: JsonValue;
  expected: JsonValue;
}

export interface ProcedureTestFailure {
  index: number;
  expected: JsonValue;
  got: JsonValue | null;
  error?: string;
}

export interface ProcedureTestResult {
  passed: boolean;
  accuracy: number;
  failures: ProcedureTestFailure[];
}

/** Test a procedure against examples. Interpreter errors count as failures. */
export function testProcedure(p: Procedure, examples: ProcedureExample[]): ProcedureTestResult {
  const failures: ProcedureTestFailure[] = [];
  examples.forEach((ex, index) => {
    try {
      const got = runProcedure(p, ex.input);
      if (!deepEqual(got, ex.expected)) {
        failures.push({ index, expected: ex.expected, got });
      }
    } catch (err) {
      failures.push({
        index,
        expected: ex.expected,
        got: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  const passed = failures.length === 0;
  return {
    passed,
    accuracy: examples.length === 0 ? 0 : (examples.length - failures.length) / examples.length,
    failures,
  };
}

export interface EnumerationTask {
  examples: ProcedureExample[];
  /** Max ops per candidate. Default 3. */
  maxOps?: number;
}

/** Hard bound on enumerated candidates — enumeration always terminates. */
export const ENUMERATION_CANDIDATE_CAP = 20000;

interface Harvest {
  numericFields: Map<string, number[]>;
  stringFields: Map<string, string[]>;
  arrayPaths: string[];
}

function harvestFields(value: JsonValue, prefix: string, h: Harvest): void {
  if (Array.isArray(value)) {
    if (
      prefix &&
      value.length > 0 &&
      value.every((x) => typeof x === 'object' && x !== null && !Array.isArray(x))
    ) {
      if (!h.arrayPaths.includes(prefix)) h.arrayPaths.push(prefix);
    }
    for (const item of value) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        for (const [k, v] of Object.entries(item)) {
          const path = prefix ? `${prefix}.${k}` : k;
          if (typeof v === 'number' && Number.isFinite(v)) {
            const arr = h.numericFields.get(path) ?? [];
            if (!arr.includes(v)) arr.push(v);
            h.numericFields.set(path, arr);
          } else if (typeof v === 'string') {
            const arr = h.stringFields.get(path) ?? [];
            if (!arr.includes(v)) arr.push(v);
            h.stringFields.set(path, arr);
          }
        }
      }
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (Array.isArray(v)) harvestFields(v, path, h);
    }
  }
}

function candidatePredicates(h: Harvest): DslPredicate[] {
  const preds: DslPredicate[] = [];
  for (const [path, values] of h.numericFields) {
    for (const v of values) {
      preds.push({ kind: 'gt', path, value: v });
      preds.push({ kind: 'lt', path, value: v });
    }
  }
  for (const [path, values] of h.stringFields) {
    if (values.length <= 10) {
      for (const v of values) preds.push({ kind: 'eq', path, value: v });
    }
  }
  return preds;
}

/**
 * Enumerate candidate procedures from templates, keep those passing ALL
 * examples, ranked by J(p) (accuracy first, then shorter). Deterministic:
 * candidates are deduplicated and sorted before testing, ids assigned in
 * enumeration order.
 *
 * Templates (bounded by maxOps):
 *   [count], [first], [get(path)]
 *   [filter(pred), count|first|sum(f)|mean(f)]
 *   [get(arrayPath), filter(pred), count|first|sum(f)|mean(f)]
 */
export function enumerateProcedures(task: EnumerationTask): Procedure[] {
  const maxOps = Math.max(1, Math.min(task.examples.length === 0 ? 1 : 3, task.maxOps ?? 3));
  const h: Harvest = { numericFields: new Map(), stringFields: new Map(), arrayPaths: [] };
  for (const ex of task.examples) harvestFields(ex.input, '', h);
  const preds = candidatePredicates(h);
  const numericPaths = [...h.numericFields.keys()];

  const seen = new Set<string>();
  const templates: DslOp[][] = [];
  const add = (ops: DslOp[]): void => {
    if (ops.length === 0 || ops.length > maxOps) return;
    const key = JSON.stringify(ops);
    if (seen.has(key)) return;
    seen.add(key);
    templates.push(ops);
  };

  add([{ op: 'count' }]);
  add([{ op: 'first' }]);
  for (const p of h.arrayPaths) add([{ op: 'get', path: p }]);

  const tails: DslOp[][] = [[{ op: 'count' }], [{ op: 'first' }]];
  for (const f of numericPaths) {
    tails.push([{ op: 'sum', path: f }]);
    tails.push([{ op: 'mean', path: f }]);
  }
  for (const pred of preds) {
    for (const tail of tails) {
      add([{ op: 'filter', where: pred }, ...tail]);
      for (const arrPath of h.arrayPaths) {
        add([{ op: 'get', path: arrPath }, { op: 'filter', where: pred }, ...tail]);
      }
    }
  }

  const found: { proc: Procedure; accuracy: number }[] = [];
  let n = 0;
  // Deterministic order: sort by serialized form before testing.
  templates.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  for (const ops of templates) {
    if (n >= ENUMERATION_CANDIDATE_CAP) break;
    n++;
    const proc: Procedure = { id: `p${found.length}`, ops };
    const t = testProcedure(proc, task.examples);
    if (t.passed) found.push({ proc, accuracy: t.accuracy });
  }
  // Rank by J(p): accuracy desc, then fewer ops. Reassign ids in rank order.
  found.sort(
    (a, b) =>
      procedureObjective(b.accuracy, b.proc.ops.length) -
        procedureObjective(a.accuracy, a.proc.ops.length) || a.proc.id.localeCompare(b.proc.id),
  );
  return found.map(({ proc }, i) => ({ ...proc, id: `p${i}` }));
}

/**
 * Pick the best procedure by J(p) = accuracy − λ_size·|p|.
 * Returns null when no candidate passes every example.
 */
export function bestProcedure(
  candidates: Procedure[],
  examples: ProcedureExample[],
): Procedure | null {
  let best: Procedure | null = null;
  let bestJ = -Infinity;
  for (const c of candidates) {
    const t = testProcedure(c, examples);
    if (!t.passed) continue;
    const j = procedureObjective(t.accuracy, c.ops.length);
    if (j > bestJ) {
      bestJ = j;
      best = c;
    }
  }
  return best;
}

/**
 * Prune with a counterexample: drop every candidate whose output on the
 * counterexample input differs from the expected output (or that errors).
 * Counterexamples are how wrong procedures die — a procedure survives only
 * while no counterexample refutes it.
 */
export function pruneWithCounterexample(
  candidates: Procedure[],
  counterexample: ProcedureExample,
): Procedure[] {
  return candidates.filter((c) => {
    try {
      return deepEqual(runProcedure(c, counterexample.input), counterexample.expected);
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Promotion gate.
// ---------------------------------------------------------------------------

/** Module-local registry of promoted procedure ids. */
const promotedIds = new Set<string>();

export interface PromotionRequest {
  procedure: Procedure;
  /**
   * Injected by the caller: runs the EXISTING frozen dev-gate machinery
   * (no per-sentence regression, stale-activation rejection). This module
   * never imports lib/context-model and never invents gates — it only asks.
   */
  gateCheck: () => boolean;
  note?: string;
}

export interface PromotionResult {
  promoted: boolean;
  reason: string;
}

/**
 * Promotion gate. The procedure is registered (and becomes eligible for the
 * `local` arm via isProcedureEligible) ONLY if the caller's dev-gate check
 * passes. A failed gate refuses promotion with an explicit reason — promotion
 * is never silent.
 */
export function promoteProcedure(req: PromotionRequest): PromotionResult {
  let gateOk = false;
  try {
    gateOk = req.gateCheck() === true;
  } catch (err) {
    return {
      promoted: false,
      reason: `dev-gate check threw (${err instanceof Error ? err.message : String(err)}); promotion refused`,
    };
  }
  if (!gateOk) {
    return { promoted: false, reason: 'dev-gate check failed; promotion refused' };
  }
  promotedIds.add(req.procedure.id);
  return {
    promoted: true,
    reason: `procedure '${req.procedure.id}' passed the dev-gate and was promoted`,
  };
}

/**
 * Whether a procedure id has been promoted through the dev-gate.
 * The arm-selection layer consults this: promoted procedures are eligible
 * for the `local` arm (zero remote calls).
 */
export function isProcedureEligible(id: string): boolean {
  return promotedIds.has(id);
}

/** Promoted ids, for inspection. */
export function listPromotedProcedureIds(): string[] {
  return [...promotedIds].sort();
}

/** Test-only: clear the promotion registry. */
export function resetPromotedProcedures(): void {
  promotedIds.clear();
}
