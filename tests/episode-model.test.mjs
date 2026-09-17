import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'hikmah-episode-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, 'episode-model.mjs');
// Browser bundling is also a portability check: the kernel must not import Node APIs.
await build({
  entryPoints: ['lib/research/episode-model.ts'],
  outfile: output,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  logLevel: 'silent',
});
const { EpisodeModel, EPISODE_LIMITS, EPISODE_PROVENANCE } = await import(pathToFileURL(output));

const cells = ['0', '1'];
const senses = { A: ['0', '1'], B: ['0', '1'] };
const allowedSets = [['0'], ['1'], ['0', '1']];
const keys = ['A', 'B'];
const row = (rowId, key, sense, allowed, episode = null) => ({
  rowId,
  key,
  sense,
  allowed,
  episode,
  source: 'authored-fixture',
});

// Independent reference: enumerate all 16 COMPLETE tables first, then check
// each episode's possible context witnesses. It never calls kernel internals.
function oracle(rows, key, query) {
  const groups = new Map();
  for (const observation of rows) {
    const id = JSON.stringify(
      observation.episode == null ? ['row', observation.rowId] : ['episode', observation.episode],
    );
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(observation);
  }
  const answers = new Set();
  let feasible = false;
  for (let encoding = 0; encoding < 16; encoding++) {
    const valueAt = (symbol, cell) =>
      String((encoding >> (keys.indexOf(symbol) * 2 + Number(cell))) & 1);
    const witnesses = new Map();
    let valid = true;
    for (const [id, observations] of groups) {
      const possible = cells.filter((cell) =>
        observations.every(
          (observation) =>
            observation.allowed.includes(cell) &&
            valueAt(observation.key, cell) === observation.sense,
        ),
      );
      if (!possible.length) {
        valid = false;
        break;
      }
      witnesses.set(id, possible);
    }
    if (!valid) continue;
    feasible = true;
    const queryCells =
      query.episode === undefined
        ? query.allowed
        : witnesses.get(JSON.stringify(['episode', query.episode]));
    for (const cell of queryCells) answers.add(valueAt(key, cell));
  }
  const candidates = [...answers].sort();
  return {
    status: !feasible ? 'INCONSISTENT' : candidates.length === 1 ? 'ENTAILED' : 'AMBIGUOUS',
    candidates,
  };
}

function verifyProofs(model, key, query, result) {
  for (const candidate of result.candidates) {
    const proof = result.proofs[candidate];
    assert.ok(proof, `Missing proof for ${candidate}`);
    const table = new Map(
      proof.table.map(([symbol, cell, sense]) => [JSON.stringify([symbol, cell]), sense]),
    );
    assert.equal(table.size, Object.keys(model.senses).length * model.cells.length);
    assert.equal(proof.table.length, table.size);
    for (const [symbol, cell, sense] of proof.table) {
      assert.ok(model.cells.includes(cell));
      assert.ok(model.senses[symbol].includes(sense));
    }
    const bindings = new Map(
      proof.bindings.map(([kind, id, cell]) => [JSON.stringify([kind, id]), cell]),
    );
    assert.equal(bindings.size, proof.bindings.length);
    for (const observation of model.rows) {
      const group = JSON.stringify(
        observation.episode === null
          ? ['row', observation.rowId]
          : ['episode', observation.episode],
      );
      const cell = bindings.get(group);
      assert.ok(observation.allowed.includes(cell));
      assert.equal(table.get(JSON.stringify([observation.key, cell])), observation.sense);
    }
    if (query.episode === undefined) assert.ok(query.allowed.includes(proof.queryCell));
    else assert.equal(proof.queryCell, bindings.get(JSON.stringify(['episode', query.episode])));
    assert.equal(table.get(JSON.stringify([key, proof.queryCell])), candidate);
  }
}

test('independent complete-table oracle agrees for 301 ledgers and 2,694 queries; all witnesses satisfy the evidence', () => {
  const atoms = keys.flatMap((key) =>
    allowedSets.flatMap((allowed) => ['0', '1'].map((sense) => ({ key, allowed, sense }))),
  );
  const ledgers = [[]];
  for (const atom of atoms) ledgers.push([row('r0', atom.key, atom.sense, atom.allowed, 'e0')]);
  for (const shared of [false, true])
    for (const first of atoms)
      for (const second of atoms)
        ledgers.push([
          row('r0', first.key, first.sense, first.allowed, 'e0'),
          row('r1', second.key, second.sense, second.allowed, shared ? 'e0' : 'e1'),
        ]);
  let queries = 0,
    certificates = 0;
  const totals = { ENTAILED: 0, AMBIGUOUS: 0, INCONSISTENT: 0 };
  for (const observations of ledgers) {
    const model = new EpisodeModel(cells, senses);
    observations.forEach((observation) => model.add(observation));
    const queriesForLedger = [
      ...allowedSets.map((allowed) => ({ allowed })),
      ...[...new Set(observations.map((observation) => observation.episode))].map((episode) => ({
        episode,
      })),
    ];
    for (const key of keys)
      for (const query of queriesForLedger) {
        const actual = model.query(key, query);
        assert.deepEqual(
          { status: actual.status, candidates: actual.candidates },
          oracle(observations, key, query),
        );
        assert.equal(actual.value, actual.status === 'ENTAILED' ? actual.candidates[0] : null);
        assert.equal(actual.searchComplete, true);
        assert.equal(actual.automaticFactualWrites, false);
        verifyProofs(model, key, query, actual);
        totals[actual.status]++;
        certificates += actual.candidates.length;
        queries++;
      }
  }
  assert.equal(ledgers.length, 301);
  assert.equal(queries, 2_694);
  assert.equal(certificates, 3_492);
  assert.deepEqual(totals, { ENTAILED: 776, AMBIGUOUS: 1_358, INCONSISTENT: 560 });
});

function bindingModel(shared = true) {
  const model = new EpisodeModel(['scene-1', 'scene-2'], {
    anchor: ['RED', 'BLUE'],
    symbol: ['CUP', 'BALL'],
  });
  model.add(row('anchor1', 'anchor', 'RED', ['scene-1']));
  model.add(row('anchor2', 'anchor', 'BLUE', ['scene-2']));
  model.add(
    row('partial-anchor', 'anchor', 'RED', model.cells, shared ? 'recorded-instant' : null),
  );
  model.add(
    row('partial-symbol', 'symbol', 'CUP', model.cells, shared ? 'recorded-instant' : null),
  );
  return model;
}

test('supplied identity binds a partial label; retraction restores ambiguity and invalidates receipts', () => {
  const query = { allowed: ['scene-1'] };
  const independent = bindingModel(false).query('symbol', query);
  assert.equal(independent.status, 'AMBIGUOUS');
  assert.deepEqual(independent.candidates, ['BALL', 'CUP']);
  const shared = bindingModel();
  const result = shared.query('symbol', query);
  assert.equal(result.status, 'ENTAILED');
  assert.equal(result.value, 'CUP');
  assert.equal(shared.receiptIsCurrent(result), true);
  assert.equal(shared.query('symbol', { episode: 'recorded-instant' }).value, 'CUP');
  shared.retract('partial-anchor');
  assert.equal(shared.receiptIsCurrent(result), false);
  assert.equal(shared.query('symbol', query).status, 'AMBIGUOUS');
});

test('a false SAME declaration can produce a wrong answer despite individually true labels', () => {
  // Same observed input, but actual partial-symbol episode was scene-2.
  // CUP at scene-2 and BALL at scene-1 makes every label individually true.
  const result = bindingModel().query('symbol', { allowed: ['scene-1'] });
  const withheldCounterfactualTruth = 'BALL';
  assert.equal(result.status, 'ENTAILED');
  assert.notEqual(result.value, withheldCounterfactualTruth);
  assert.equal(result.automaticFactualWrites, false);
});

test('conflicting labels and disjoint same-episode contexts report inconsistency, never vacuous entailment', () => {
  for (const observations of [
    [row('r0', 'A', '0', cells, 'e'), row('r1', 'A', '1', cells, 'e')],
    [row('r0', 'A', '0', ['0'], 'e'), row('r1', 'B', '0', ['1'], 'e')],
  ]) {
    const model = new EpisodeModel(cells, senses);
    observations.forEach((observation) => model.add(observation));
    const result = model.query('A', { allowed: cells });
    assert.equal(result.status, 'INCONSISTENT');
    assert.equal(result.value, null);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(Object.keys(result.proofs), []);
    model.retract('r1');
    assert.notEqual(model.query('A', { allowed: cells }).status, 'INCONSISTENT');
  }
});

test('distinct episode IDs can share a context; row IDs cannot collide with episode identities', () => {
  const model = new EpisodeModel(cells, senses);
  model.add(row('r0', 'A', '0', ['0'], 'first'));
  model.add(row('r1', 'A', '0', ['0'], 'second'));
  assert.equal(model.query('A', { episode: 'second' }).value, '0');
  const collision = new EpisodeModel(cells, senses);
  collision.add(row('r0', 'A', '0', cells, 'collision'));
  collision.add(row('collision', 'A', '1', cells));
  assert.equal(collision.query('A', { allowed: cells }).status, 'AMBIGUOUS');
});

test('resource exhaustion after partial discovery clears all candidate answers and proof certificates', () => {
  const model = new EpisodeModel(cells, senses);
  model.add(row('r0', 'A', '0', cells, 'e'));
  const before = model.fingerprint();
  for (const [options, cause] of [
    [{ budget: 2 }, 'search_nodes'],
    [{ workBudget: 1 }, 'work_units'],
  ]) {
    const result = model.query('B', { allowed: ['0'], ...options });
    assert.equal(result.status, 'RESOURCE_LIMIT');
    assert.equal(result.resourceLimit, cause);
    assert.equal(result.searchComplete, false);
    assert.equal(result.value, null);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(Object.keys(result.proofs), []);
    assert.equal(result.compatibleWitnessAssignments, null);
    assert.equal(model.fingerprint(), before);
  }
  assert.equal(model.query('B', { allowed: ['0'] }).status, 'AMBIGUOUS');
});

test('proof output has a byte budget even when an unconstrained inference uses one search node', () => {
  const long = (prefix, index) => `${prefix}-${index}-`.padEnd(200, 'x');
  const context = Array.from({ length: 64 }, (_, index) => long('cell', index));
  const inventory = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      long('key', index),
      Array.from({ length: 32 }, (_, value) => long('sense', value)),
    ]),
  );
  const result = new EpisodeModel(context, inventory).query(long('key', 0), {
    allowed: [context[0]],
  });
  assert.equal(result.status, 'RESOURCE_LIMIT');
  assert.equal(result.resourceLimit, 'proof_bytes');
  assert.equal(result.value, null);
  assert.equal(result.candidates.length, 0);
  assert.equal(Object.keys(result.proofs).length, 0);
});

test('scope-bound receipts are deterministic, survive snapshots and reject any later revision', () => {
  const observations = [row('b', 'A', '0', ['0']), row('a', 'B', '1', ['1'])];
  const first = new EpisodeModel(cells, senses, { scopeId: 'tenant-1:project-1' });
  const second = new EpisodeModel(
    [...cells],
    { B: ['0', '1'], A: ['0', '1'] },
    { scopeId: 'tenant-1:project-1' },
  );
  observations.forEach((observation) => first.add(observation));
  [...observations].reverse().forEach((observation) => second.add(observation));
  assert.equal(first.fingerprint(), second.fingerprint());
  assert.match(first.fingerprint(), /^[a-f0-9]{64}$/);
  const copy = EpisodeModel.fromSnapshot(JSON.parse(JSON.stringify(first.snapshot())));
  const result = first.query('A', { allowed: ['0'] });
  assert.equal(copy.receiptIsCurrent(result), true);
  assert.deepEqual(copy.query('A', { allowed: ['0'] }), result);
  const other = EpisodeModel.fromSnapshot({ ...first.snapshot(), scopeId: 'tenant-2:project-1' });
  assert.equal(other.receiptIsCurrent(result), false);
  copy.retract('a');
  copy.add(observations[1]);
  assert.equal(copy.receiptIsCurrent(result), false);
  assert.notEqual(copy.fingerprint(), first.fingerprint());
  const changedSource = EpisodeModel.fromSnapshot({
    ...first.snapshot(),
    rows: first.rows.map((item) => ({ ...item, source: 'different-origin' })),
  });
  assert.notEqual(changedSource.fingerprint(), first.fingerprint());
});

test('caller mutation and prototype-like names cannot corrupt evidence, inventories or proofs', () => {
  const context = ['0', '1'],
    inventory = JSON.parse('{"__proto__":["__proto__","constructor"],"toJSON":["red","blue"]}');
  const model = new EpisodeModel(context, inventory);
  const observation = row('r0', '__proto__', '__proto__', ['0']);
  model.add(observation);
  const before = model.fingerprint();
  observation.allowed[0] = '1';
  inventory.__proto__[0] = 'changed';
  context[0] = 'changed';
  assert.equal(model.fingerprint(), before);
  const result = model.query('__proto__', { allowed: ['0'] });
  assert.equal(result.value, '__proto__');
  assert.ok(Object.hasOwn(result.proofs, '__proto__'));
  assert.throws(() => {
    model.rows[0].allowed[0] = '1';
  }, TypeError);
  assert.throws(() => {
    model.senses.__proto__[0] = 'bad';
  }, TypeError);
  result.proofs.__proto__.table[0][2] = 'corrupted-output';
  assert.equal(model.query('__proto__', { allowed: ['0'] }).value, '__proto__');
  assert.equal({}.polluted, undefined);
});

test('invalid schemas, unknown symbols, malformed Unicode and oversized inputs fail before mutation', () => {
  assert.throws(() => new EpisodeModel([], senses));
  assert.throws(() => new EpisodeModel(cells, {}));
  assert.throws(() => new EpisodeModel(['0', '0'], senses));
  assert.throws(
    () =>
      new EpisodeModel(
        Array.from({ length: EPISODE_LIMITS.cells + 1 }, (_, index) => String(index)),
        senses,
      ),
  );
  assert.throws(
    () =>
      new EpisodeModel(cells, {
        A: Array.from({ length: EPISODE_LIMITS.sensesPerKey + 1 }, (_, index) => String(index)),
      }),
  );
  assert.throws(() => new EpisodeModel(['ع'.repeat(129)], senses));
  assert.throws(() => new EpisodeModel(['\ud800'], senses));
  const model = new EpisodeModel(cells, senses);
  const before = model.fingerprint();
  for (const bad of [
    { ...row('r0', 'A', '0', ['0']), extra: true },
    row('r0', 'X', '0', ['0']),
    row('r0', 'A', 'X', ['0']),
    row('r0', 'A', '0', ['unknown']),
    row('r0', 'A', '0', []),
    { ...row('r0', 'A', '0', ['0']), source: 'ع'.repeat(1_025) },
  ])
    assert.throws(() => model.add(bad));
  assert.equal(model.fingerprint(), before);
  for (const query of [
    {},
    { allowed: cells, episode: 'e' },
    { allowed: [] },
    { episode: 'missing' },
    { allowed: cells, budget: true },
    { allowed: cells, budget: Infinity },
    { allowed: cells, budget: EPISODE_LIMITS.searchNodes + 1 },
    { allowed: cells, workBudget: EPISODE_LIMITS.workUnits + 1 },
  ])
    assert.throws(() => model.query('A', query));
  assert.throws(() => model.retract('missing'));
  model.add(row('r0', 'A', '0', ['0']));
  assert.throws(() => model.add(row('r0', 'A', '0', ['0'])));
  for (const revision of [-1, 0, 1.5, NaN])
    assert.throws(() => EpisodeModel.fromSnapshot({ ...model.snapshot(), revision }));
  assert.throws(() =>
    EpisodeModel.fromSnapshot({ ...model.snapshot(), engine: 'invented-stage32' }),
  );
});

test('accessors are rejected without invoking input code', () => {
  let invoked = false;
  const model = new EpisodeModel(cells, senses);
  const observation = row('r0', 'A', '0', ['0']);
  Object.defineProperty(observation, 'sense', {
    get() {
      invoked = true;
      return '0';
    },
    enumerable: true,
  });
  assert.throws(() => model.add(observation), /accessors/);
  const values = ['0', '1'];
  Object.defineProperty(values, '0', {
    get() {
      invoked = true;
      return '0';
    },
    enumerable: true,
  });
  assert.throws(() => new EpisodeModel(values, senses), /accessors/);
  assert.equal(invoked, false);
  assert.equal(model.rows.length, 0);
});

test('cumulative snapshot byte and row caps are atomic and snapshots remain exportable', () => {
  const context = Array.from({ length: 64 }, (_, index) => `cell-${index}-`.padEnd(256, 'x'));
  const model = new EpisodeModel(context, { A: ['0', '1'] });
  let stopped = false;
  for (let index = 0; index < EPISODE_LIMITS.observations; index++) {
    const receipt = model.fingerprint(),
      size = model.rows.length;
    try {
      model.add({ ...row(`r${index}`, 'A', '0', context), source: 'x'.repeat(2_048) });
    } catch (error) {
      assert.match(error.message, /byte limit/);
      assert.equal(model.rows.length, size);
      assert.equal(model.fingerprint(), receipt);
      stopped = true;
      break;
    }
  }
  assert.equal(stopped, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(model.snapshot()), 'utf8') <= EPISODE_LIMITS.inputBytes,
  );
  const compact = new EpisodeModel(cells, senses);
  for (let index = 0; index < EPISODE_LIMITS.observations; index++)
    compact.add(row(`r${index}`, 'A', '0', ['0']));
  assert.throws(() => compact.add(row('excess', 'A', '0', ['0'])), /Observation limit/);
});

test('provenance exposes the actual source and does not claim unavailable checkpoint verification', () => {
  assert.equal(EPISODE_PROVENANCE.engine, 'shared-episode-v1');
  assert.equal(EPISODE_PROVENANCE.completedStage31Or32Verified, false);
  assert.equal(EPISODE_PROVENANCE.parentArchiveVerifiedInThisIntegration, false);
  assert.equal(
    EPISODE_PROVENANCE.pythonSourceSha256,
    '2f71cfec834b28ac295578248b5d0aa2364304a596ac4331ed896eaa2ce83199',
  );
});
