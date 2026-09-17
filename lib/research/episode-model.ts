/**
 * Experimental finite evidence solver, ported from the 2026-09-17 standalone
 * shared-episode prototype. Inputs are supplied annotations, not parsed language.
 * Entailment is conditional on their truth and completeness. No factual writes.
 */
import { sha256 } from '../engines/meaning-engine.ts';

export const EPISODE_LIMITS = Object.freeze({
  cells: 64,
  keys: 16,
  observations: 128,
  sensesPerKey: 32,
  nameBytes: 256,
  sourceBytes: 2_048,
  inputBytes: 512 * 1_024,
  searchNodes: 100_000,
  workUnits: 2_000_000,
  proofBytes: 1_024 * 1_024,
});

export const EPISODE_PROVENANCE = Object.freeze({
  engine: 'shared-episode-v1' as const,
  status: 'experimental standalone extension' as const,
  sourceDate: '2026-09-17',
  pythonSourceSha256: '2f71cfec834b28ac295578248b5d0aa2364304a596ac4331ed896eaa2ce83199',
  parentArchiveSha256: '43484ef701f164755dbc61a91581ce8c9394eb825fa2bdb7f41216b770016de9',
  parentArchiveVerifiedInThisIntegration: false,
  completedStage31Or32Verified: false,
});

export type EpisodeObservation = Readonly<{
  rowId: string;
  key: string;
  sense: string;
  allowed: readonly string[];
  episode?: string | null;
  source?: string;
}>;
type StoredObservation = Readonly<Required<EpisodeObservation>>;
export type EpisodeQuery = Readonly<{
  allowed?: readonly string[];
  episode?: string;
  budget?: number;
  workBudget?: number;
}>;
export type EpisodeProof = {
  table: [key: string, cell: string, sense: string][];
  bindings: [kind: 'episode' | 'row', id: string, cell: string][];
  queryCell: string;
};
export type EpisodeResult = {
  status: 'ENTAILED' | 'AMBIGUOUS' | 'INCONSISTENT' | 'RESOURCE_LIMIT';
  value: string | null;
  candidates: string[];
  proofs: Record<string, EpisodeProof>;
  searchComplete: boolean;
  searchNodes: number;
  workUnits: number;
  resourceLimit: 'search_nodes' | 'work_units' | 'proof_bytes' | null;
  compatibleWitnessAssignments: number | null;
  receipt: string;
  automaticFactualWrites: false;
  scope: string;
};
export type EpisodeSnapshot = Readonly<{
  engine: typeof EPISODE_PROVENANCE.engine;
  scopeId: string;
  cells: readonly string[];
  senses: Readonly<Record<string, readonly string[]>>;
  rows: readonly StoredObservation[];
  revision: number;
}>;

const encoder = new TextEncoder();
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const fail = (message: string): never => {
  throw new TypeError(message);
};

// Accept only inert JSON-shaped values; do not execute input getters or toJSON.
function record(value: unknown, label: string, maxKeys: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) fail(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value as object);
  if (keys.length > maxKeys || keys.some((key) => typeof key !== 'string'))
    fail(`Invalid ${label} fields`);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable)
      fail(`${label} cannot contain accessors`);
    result[key] = descriptor.value;
  }
  return result;
}

function fields(
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  const data = record(value, label, allowed.length);
  if (Object.keys(data).some((key) => !allowed.includes(key))) fail(`Unknown ${label} field`);
  return data;
}

function name(value: unknown, label: string, maxBytes: number = EPISODE_LIMITS.nameBytes): string {
  if (typeof value !== 'string' || !value.length || value.length > maxBytes)
    fail(`Invalid ${label}`);
  const text = value as string;
  // Reject lone surrogates so distinct strings cannot hash as UTF-8 replacement characters.
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`Invalid Unicode in ${label}`);
    } else if (code >= 0xdc00 && code <= 0xdfff) fail(`Invalid Unicode in ${label}`);
  }
  if (encoder.encode(text).byteLength > maxBytes) fail(`${label} exceeds byte limit`);
  return text;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    fail(`${label} must be an array with at most ${max} items`);
  const input = value as unknown[];
  if (Reflect.ownKeys(input).length !== input.length + 1) fail(`Invalid ${label} array properties`);
  const result: unknown[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !('value' in descriptor)) fail(`${label} cannot contain holes or accessors`);
    result.push(descriptor!.value);
  }
  return result;
}

function names(value: unknown, label: string, max: number): readonly string[] {
  const result = array(value, label, max).map((item) => name(item, label));
  if (!result.length || new Set(result).size !== result.length)
    fail(`${label} must be nonempty and unique`);
  return Object.freeze(result);
}

function budget(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > fallback)
    fail(`${label} must be an integer from 1 to ${fallback}`);
  return value as number;
}

/** Callers should use exact, namespaced language/symbol identities in `senses`. */
export class EpisodeModel {
  #cells: readonly string[];
  #senses: Readonly<Record<string, readonly string[]>>;
  #scopeId: string;
  #rows = new Map<string, StoredObservation>();
  #revision = 0;
  #receipt: string | null = null;

  constructor(
    cells: readonly string[],
    senses: Readonly<Record<string, readonly string[]>>,
    options: { scopeId?: string } = {},
  ) {
    this.#cells = names(cells, 'cells', EPISODE_LIMITS.cells);
    const rawSenses = record(senses, 'senses', EPISODE_LIMITS.keys);
    const keys = Object.keys(rawSenses).sort(compare);
    if (!keys.length) fail('senses must contain at least one key');
    const inventory = Object.create(null) as Record<string, readonly string[]>;
    for (const key of keys) {
      name(key, 'symbol key');
      inventory[key] = names(rawSenses[key], 'sense inventory', EPISODE_LIMITS.sensesPerKey);
    }
    this.#senses = Object.freeze(inventory);
    const opts = fields(options, ['scopeId'], 'model options');
    this.#scopeId = name(opts.scopeId ?? 'research:local', 'scopeId');
    this.#checkSize(this.rows);
  }

  get cells(): readonly string[] {
    return this.#cells;
  }
  get senses(): Readonly<Record<string, readonly string[]>> {
    return this.#senses;
  }
  get scopeId(): string {
    return this.#scopeId;
  }
  get rows(): readonly StoredObservation[] {
    return Object.freeze([...this.#rows.values()].sort((a, b) => compare(a.rowId, b.rowId)));
  }

  #state(rows: readonly StoredObservation[], revision = this.#revision): EpisodeSnapshot {
    return Object.freeze({
      engine: EPISODE_PROVENANCE.engine,
      scopeId: this.#scopeId,
      cells: this.#cells,
      senses: this.#senses,
      rows,
      revision,
    });
  }

  #checkSize(rows: readonly StoredObservation[], revision = this.#revision): void {
    if (bytes(this.#state(rows, revision)) > EPISODE_LIMITS.inputBytes)
      fail('Evidence snapshot exceeds byte limit');
  }

  add(observation: EpisodeObservation): void {
    const row = fields(
      observation,
      ['rowId', 'key', 'sense', 'allowed', 'episode', 'source'],
      'observation',
    );
    const rowId = name(row.rowId, 'rowId');
    const key = name(row.key, 'key');
    const sense = name(row.sense, 'sense');
    const allowed = names(row.allowed, 'allowed cells', EPISODE_LIMITS.cells);
    const episode = row.episode == null ? null : name(row.episode, 'episode');
    const source = name(
      row.source === undefined ? 'author-supplied' : row.source,
      'source',
      EPISODE_LIMITS.sourceBytes,
    );
    if (this.#rows.has(rowId)) fail('Duplicate rowId');
    if (this.#rows.size >= EPISODE_LIMITS.observations) fail('Observation limit exceeded');
    if (!Object.hasOwn(this.#senses, key) || !this.#senses[key].includes(sense))
      fail('Unknown key or sense');
    if (allowed.some((cell) => !this.#cells.includes(cell))) fail('Unknown context cell');
    if (this.#revision >= Number.MAX_SAFE_INTEGER) fail('Revision limit exceeded');
    const stored = Object.freeze({ rowId, key, sense, allowed, episode, source });
    this.#checkSize([...this.rows, stored], this.#revision + 1);
    this.#rows.set(rowId, stored);
    this.#revision++;
    this.#receipt = null;
  }

  retract(rowId: string): void {
    name(rowId, 'rowId');
    if (!this.#rows.has(rowId)) fail('Unknown rowId');
    if (this.#revision >= Number.MAX_SAFE_INTEGER) fail('Revision limit exceeded');
    this.#rows.delete(rowId);
    this.#revision++;
    this.#receipt = null;
  }

  snapshot(): EpisodeSnapshot {
    return this.#state(this.rows);
  }

  static fromSnapshot(value: unknown): EpisodeModel {
    const input = fields(
      value,
      ['engine', 'scopeId', 'cells', 'senses', 'rows', 'revision'],
      'snapshot',
    );
    if (input.engine !== EPISODE_PROVENANCE.engine) fail('Unsupported episode engine');
    const rows = array(input.rows, 'rows', EPISODE_LIMITS.observations);
    if (
      typeof input.revision !== 'number' ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < rows.length
    )
      fail('Invalid snapshot revision');
    const model = new EpisodeModel(
      input.cells as string[],
      input.senses as Record<string, string[]>,
      { scopeId: name(input.scopeId, 'scopeId') },
    );
    for (const row of rows) model.add(row as EpisodeObservation);
    model.#revision = input.revision as number;
    model.#checkSize(model.rows);
    model.#receipt = null;
    return model;
  }

  fingerprint(): string {
    // Ordered tuples avoid object-key insertion order and prototype-key behavior.
    this.#receipt ??= sha256(
      JSON.stringify([
        EPISODE_PROVENANCE.engine,
        this.#scopeId,
        this.#revision,
        this.#cells,
        Object.keys(this.#senses)
          .sort(compare)
          .map((key) => [key, this.#senses[key]]),
        this.rows.map((row) => [
          row.rowId,
          row.key,
          row.sense,
          row.allowed,
          row.episode,
          row.source,
        ]),
      ]),
    );
    return this.#receipt;
  }

  receiptIsCurrent(result: Pick<EpisodeResult, 'receipt'>): boolean {
    return result?.receipt === this.fingerprint();
  }

  query(key: string, options: EpisodeQuery): EpisodeResult {
    name(key, 'query key');
    if (!Object.hasOwn(this.#senses, key)) fail('Unknown query key');
    const opts = fields(options, ['allowed', 'episode', 'budget', 'workBudget'], 'query');
    const nodeLimit = budget(opts.budget, EPISODE_LIMITS.searchNodes, 'budget');
    const workLimit = budget(opts.workBudget, EPISODE_LIMITS.workUnits, 'workBudget');
    if ((opts.allowed === undefined) === (opts.episode === undefined))
      fail('Specify exactly one of allowed or episode');
    const allowed =
      opts.allowed === undefined ? null : names(opts.allowed, 'query cells', EPISODE_LIMITS.cells);
    const episode = opts.episode === undefined ? null : name(opts.episode, 'query episode');
    if (allowed?.some((cell) => !this.#cells.includes(cell))) fail('Unknown query cell');
    if (episode !== null && !this.rows.some((row) => row.episode === episode))
      fail('Unknown query episode');

    type Group = {
      kind: 'row' | 'episode';
      id: string;
      cells: Set<string>;
      values: Map<string, string>;
    };
    const groups = new Map<string, Group>();
    let nodes = 0,
      leaves = 0,
      work = 0,
      proofBytes = 0;
    let resourceLimit: EpisodeResult['resourceLimit'] = null;
    const spend = (amount = 1): boolean => {
      if (resourceLimit) return false;
      if (work + amount > workLimit) {
        resourceLimit = 'work_units';
        return false;
      }
      work += amount;
      return true;
    };
    const groupId = (kind: string, id: string) => JSON.stringify([kind, id]);
    for (const row of this.rows) {
      if (!spend()) break;
      const kind = row.episode === null ? 'row' : 'episode';
      const id = row.episode ?? row.rowId;
      const token = groupId(kind, id);
      let group = groups.get(token);
      if (!group) {
        group = { kind, id, cells: new Set(this.#cells), values: new Map() };
        groups.set(token, group);
      }
      const rowAllowed = new Set(row.allowed);
      for (const cell of group.cells) {
        if (!spend()) break;
        if (!rowAllowed.has(cell)) group.cells.delete(cell);
      }
      if (group.values.has(row.key) && group.values.get(row.key) !== row.sense) group.cells.clear();
      group.values.set(row.key, row.sense);
    }
    const ordered = [...groups.values()].sort(
      (a, b) => a.cells.size - b.cells.size || compare(a.kind, b.kind) || compare(a.id, b.id),
    );
    const keys = Object.keys(this.#senses).sort(compare);
    const keyIndex = new Map(keys.map((item, index) => [item, index]));
    const cellIndex = new Map(this.#cells.map((cell, index) => [cell, index]));
    const slot = (symbol: string, cell: string) =>
      keyIndex.get(symbol)! * this.#cells.length + cellIndex.get(cell)!;
    const table = new Int16Array(keys.length * this.#cells.length).fill(-1);
    const bindings = new Map<string, string>();
    const answers = new Set<string>();
    const proofs: Record<string, EpisodeProof> = Object.create(null);

    const makeProof = (value: string, queryCell: string): void => {
      if (Object.hasOwn(proofs, value)) return;
      const proof: EpisodeProof = { table: [], bindings: [], queryCell };
      proofBytes += bytes(value) + bytes(queryCell) + 64;
      const append = <T extends unknown[]>(target: T[], tuple: T): boolean => {
        if (!spend()) return false;
        proofBytes += bytes(tuple) + 1;
        if (proofBytes > EPISODE_LIMITS.proofBytes) {
          resourceLimit = 'proof_bytes';
          return false;
        }
        target.push(tuple);
        return true;
      };
      for (const symbol of keys)
        for (const cell of [...this.#cells].sort(compare)) {
          const index = table[slot(symbol, cell)];
          const sense =
            symbol === key && cell === queryCell
              ? value
              : this.#senses[symbol][index < 0 ? 0 : index];
          if (!append(proof.table, [symbol, cell, sense])) return;
        }
      for (const group of [...ordered].sort(
        (a, b) => compare(a.kind, b.kind) || compare(a.id, b.id),
      )) {
        if (
          !append(proof.bindings, [
            group.kind,
            group.id,
            bindings.get(groupId(group.kind, group.id))!,
          ])
        )
          return;
      }
      proofs[value] = proof;
    };

    const visit = (index: number): void => {
      if (resourceLimit) return;
      if (nodes >= nodeLimit) {
        resourceLimit = 'search_nodes';
        return;
      }
      if (!spend()) return;
      nodes++;
      if (index === ordered.length) {
        leaves++;
        const queryCells =
          episode !== null ? [bindings.get(groupId('episode', episode))!] : allowed!;
        for (const cell of queryCells) {
          const bound = table[slot(key, cell)];
          const values = bound < 0 ? this.#senses[key] : [this.#senses[key][bound]];
          for (const value of values) {
            if (!spend()) return;
            answers.add(value);
            makeProof(value, cell);
            if (resourceLimit) return;
          }
        }
        return;
      }
      const group = ordered[index];
      for (const cell of [...group.cells].sort(compare)) {
        if (!spend()) return;
        const changes: number[] = [];
        let compatible = true;
        for (const [symbol, sense] of group.values) {
          if (!spend()) {
            compatible = false;
            break;
          }
          const position = slot(symbol, cell);
          const value = this.#senses[symbol].indexOf(sense);
          if (table[position] >= 0 && table[position] !== value) {
            compatible = false;
            break;
          }
          if (table[position] < 0) {
            changes.push(position);
            table[position] = value;
          }
        }
        if (compatible && !resourceLimit) {
          const token = groupId(group.kind, group.id);
          bindings.set(token, cell);
          visit(index + 1);
          bindings.delete(token);
        }
        for (const position of changes) table[position] = -1;
        if (resourceLimit) return;
      }
    };

    visit(0);
    const candidates = resourceLimit ? [] : [...answers].sort(compare);
    const status: EpisodeResult['status'] = resourceLimit
      ? 'RESOURCE_LIMIT'
      : !leaves
        ? 'INCONSISTENT'
        : candidates.length === 1
          ? 'ENTAILED'
          : 'AMBIGUOUS';
    return {
      status,
      value: status === 'ENTAILED' ? candidates[0] : null,
      candidates,
      proofs: resourceLimit ? Object.create(null) : proofs,
      searchComplete: resourceLimit === null,
      searchNodes: nodes,
      workUnits: work,
      resourceLimit,
      compatibleWitnessAssignments: resourceLimit ? null : leaves,
      receipt: this.fingerprint(),
      automaticFactualWrites: false,
      scope: 'Exact only within supplied finite tables, labels and episode identities',
    };
  }
}
