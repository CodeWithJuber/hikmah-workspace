/** Policy-gated, Jev-assisted memory auto-triage.
 *
 * The user's order was "Jev lega, human kuchh nahi" — zero per-item human
 * clicks — but with a hard invariant: Jev NEVER self-authorizes. Consent is
 * state, Jev advises, and code + policy decide. This module is where that
 * invariant lives:
 *
 * - Deterministic policy gates run first and decide alone: incognito writes
 *   nothing, credential-shaped content is blocked, transient instructions are
 *   discarded, explicit preference kinds are auto-saved.
 * - Jev only ever answers two typed questions (is it durable? save/discard/
 *   ask?) and the thresholds below turn those answers into actions. A Jev
 *   that is unreachable, slow, keyless, or malformed never saves and never
 *   silently discards — it defers.
 * - Every path, including incognito and defer, writes one row to triage_audit.
 *   The audit table is operational bookkeeping, not a memory write.
 *
 * On 'save' the candidate is persisted via the memory store with status
 * 'saved'; on 'surface' it is persisted with status 'suggested' so Agent B's
 * UI can render it as a non-blocking chip; 'discard' and 'defer' write
 * nothing to the memories table. For a deferred item the candidate itself is
 * carried inside the audit row's jev_raw (as {deferredCandidate}) — there is
 * no other place for it, and retryDeferred needs it to re-run the pipeline.
 */
import { randomUUID } from 'node:crypto';
import { createMemoryStore, type MemoryKind, type NewMemory, type SqliteHandle } from './store.ts';
import { detectPii } from './pii.ts';
import { systemOne } from '../integrations/jev-client.ts';

export type TriageAction = 'save' | 'discard' | 'surface' | 'defer';

export type TriagePolicy = {
  version: 1;
  /** Kinds auto-saved without asking Jev. The caller sets kind; 'preference'
   * means an explicit durable preference, so it is safe to save on sight. */
  autoSaveKinds: MemoryKind[];
  /** Regex strings (case-insensitive) matching transient instructions. */
  transientPatterns: string[];
  /** Extra regex strings (case-insensitive) that block a save. The
   * credential-shape regex below is always on as well. */
  secretBlocklist: string[];
  jev: {
    enabled: boolean;
    durableThreshold: number;
    discardThreshold: number;
    confidenceFloor: number;
    timeoutMs: number;
  };
  /** Hours a 'defer' waits before retryDeferred will pick it up again. */
  deferRetryHours: number;
  updatedAt: string;
  updatedBy: 'user' | 'system';
};

export type TriageDecision = {
  id: string;
  candidateId: string;
  action: TriageAction;
  rule: string;
  confidence: number | null;
  jevRaw: unknown;
  createdAt: string;
};

/** Jev client options, mirrored from lib/integrations/jev-client.ts (whose
 * JevClientOptions is not exported). Passed through to systemOne as-is. */
export type TriageJevOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

export type TriageContext = {
  /** Server-side incognito flag (the runs route's parsed request flag, not
   * the React hook): while on, nothing about this candidate is remembered. */
  incognito: boolean;
  /** The memory store is user-scoped; triage needs the owner for any write. */
  userId: string;
  jevOptions?: TriageJevOptions;
};

/** The credential-shape block, same approach as jev-client.ts's
 * secretPattern: an API-key-looking token or a bearer token. Always on,
 * independent of the policy's secretBlocklist. */
const BUILTIN_SECRET = /(sk-[A-Za-z0-9_-]{12,}|bearer\s+[A-Za-z0-9._-]{12,})/i;

const KINDS: MemoryKind[] = ['preference', 'reference', 'episode'];

const DEFAULT_POLICY: TriagePolicy = {
  version: 1,
  autoSaveKinds: ['preference'],
  transientPatterns: [
    'remind me',
    'for (this|the) session',
    'just this once',
    "don'?t (save|remember|keep)",
  ],
  secretBlocklist: [],
  jev: {
    enabled: true,
    durableThreshold: 0.8,
    discardThreshold: 0.25,
    confidenceFloor: 0.6,
    timeoutMs: 3000,
  },
  deferRetryHours: 24,
  updatedAt: '',
  updatedBy: 'system',
};

const DDL = [
  `CREATE TABLE IF NOT EXISTS triage_policy (policy_json TEXT)`,
  `CREATE TABLE IF NOT EXISTS triage_audit (
     id TEXT PRIMARY KEY,
     candidate_id TEXT NOT NULL,
     action TEXT NOT NULL,
     rule TEXT NOT NULL,
     confidence REAL,
     jev_raw TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS triage_audit_candidate ON triage_audit (candidate_id, created_at)`,
];

function ensureTables(handle: SqliteHandle): void {
  for (const ddl of DDL)
    try {
      handle.prepare(ddl).run();
    } catch {
      /* a missing table is a store that cannot be read; triage still answers */
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const clamp01 = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

const positive = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/** Stored JSON is untrusted (the policy row is writable); merge over
 * defaults so a partial or corrupt row still yields a working policy. */
function normalizePolicy(raw: unknown): TriagePolicy {
  const record = isRecord(raw) ? raw : {};
  const jev = isRecord(record.jev) ? record.jev : {};
  const d = DEFAULT_POLICY;
  // An absent array field takes the default; an explicitly empty array is a
  // deliberate "nothing here" and is kept.
  const strArray = (value: unknown, fallback: string[]): string[] =>
    value === undefined ? [...fallback] : asStrings(value);
  return {
    version: 1,
    autoSaveKinds: strArray(record.autoSaveKinds, d.autoSaveKinds).filter(
      (kind): kind is MemoryKind => (KINDS as string[]).includes(kind),
    ),
    transientPatterns: strArray(record.transientPatterns, d.transientPatterns),
    secretBlocklist: strArray(record.secretBlocklist, d.secretBlocklist),
    jev: {
      enabled: typeof jev.enabled === 'boolean' ? jev.enabled : d.jev.enabled,
      durableThreshold: clamp01(jev.durableThreshold, d.jev.durableThreshold),
      discardThreshold: clamp01(jev.discardThreshold, d.jev.discardThreshold),
      confidenceFloor: clamp01(jev.confidenceFloor, d.jev.confidenceFloor),
      timeoutMs: Math.round(positive(jev.timeoutMs, d.jev.timeoutMs)),
    },
    deferRetryHours: positive(record.deferRetryHours, d.deferRetryHours),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    updatedBy: record.updatedBy === 'user' ? 'user' : 'system',
  };
}

function defaultPolicy(): TriagePolicy {
  return { ...normalizePolicy({}), updatedAt: new Date().toISOString(), updatedBy: 'system' };
}

/** The triage policy, seeded with defaults on first read. */
export function getPolicy(handle: SqliteHandle): TriagePolicy {
  ensureTables(handle);
  try {
    const row = handle.prepare(`SELECT policy_json FROM triage_policy LIMIT 1`).get() as
      { policy_json?: string } | undefined;
    if (row?.policy_json) return normalizePolicy(JSON.parse(row.policy_json) as unknown);
  } catch {
    /* a store that cannot be read falls back to the default policy */
  }
  const seeded = defaultPolicy();
  try {
    handle
      .prepare(`INSERT INTO triage_policy (policy_json) VALUES (?)`)
      .run(JSON.stringify(seeded));
  } catch {
    /* seeding is best effort; the returned default is still correct */
  }
  return seeded;
}

/** Replace the policy wholesale; unknown fields fall back to defaults. */
export function setPolicy(handle: SqliteHandle, policy: TriagePolicy): void {
  ensureTables(handle);
  const next: TriagePolicy = {
    ...normalizePolicy(policy),
    updatedAt: new Date().toISOString(),
    updatedBy: policy.updatedBy === 'user' ? 'user' : 'system',
  };
  try {
    handle.prepare(`DELETE FROM triage_policy`).run();
    handle.prepare(`INSERT INTO triage_policy (policy_json) VALUES (?)`).run(JSON.stringify(next));
  } catch {
    /* a store that cannot be written keeps its old policy */
  }
}

type AuditRow = {
  id: string;
  candidate_id: string;
  action: string;
  rule: string;
  confidence: number | null;
  jev_raw: string | null;
  created_at: string;
};

const ACTIONS: TriageAction[] = ['save', 'discard', 'surface', 'defer'];

function fromRow(row: AuditRow): TriageDecision {
  let jevRaw: unknown = null;
  if (row.jev_raw)
    try {
      jevRaw = JSON.parse(row.jev_raw) as unknown;
    } catch {
      jevRaw = row.jev_raw;
    }
  return {
    id: row.id,
    candidateId: row.candidate_id,
    action: (ACTIONS as string[]).includes(row.action) ? (row.action as TriageAction) : 'defer',
    rule: row.rule,
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    jevRaw,
    createdAt: row.created_at,
  };
}

function writeAudit(
  handle: SqliteHandle,
  decision: Omit<TriageDecision, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
): TriageDecision {
  const full: TriageDecision = {
    id: decision.id ?? 'triage_' + randomUUID(),
    candidateId: decision.candidateId,
    action: decision.action,
    rule: decision.rule,
    confidence: decision.confidence,
    jevRaw: decision.jevRaw ?? null,
    createdAt: decision.createdAt ?? new Date().toISOString(),
  };
  try {
    handle
      .prepare(
        `INSERT INTO triage_audit
           (id, candidate_id, action, rule, confidence, jev_raw, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.id,
        full.candidateId,
        full.action,
        full.rule,
        full.confidence,
        full.jevRaw === null ? null : JSON.stringify(full.jevRaw),
        full.createdAt,
      );
  } catch {
    /* the audit row is operational; a lost row must not lose the decision */
  }
  return full;
}

/** Newest-first audit history. */
export function listDecisions(handle: SqliteHandle, limit = 50): TriageDecision[] {
  ensureTables(handle);
  try {
    const rows = handle
      .prepare(
        `SELECT id, candidate_id, action, rule, confidence, jev_raw, created_at
         FROM triage_audit ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as AuditRow[];
    return rows.map(fromRow);
  } catch {
    return [];
  }
}

function matchesAny(patterns: string[], text: string): boolean {
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, 'i').test(text)) return true;
    } catch {
      /* an invalid stored pattern blocks nothing; it is ignored, not fatal */
    }
  }
  return false;
}

/** The 'noul' answer carries a durability score; normalize its loose value
 * to 0..1. Anything unrecognized is malformed, not a guess. */
function durableScore(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.min(1, Math.max(0, value));
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true' || lower === 'yes' || lower === '1') return 1;
    if (lower === 'false' || lower === 'no' || lower === '0') return 0;
    const parsed = Number(lower);
    if (Number.isFinite(parsed)) return Math.min(1, Math.max(0, parsed));
  }
  return null;
}

const DURABLE_QUESTION: { id: string; type: 'noul'; prompt: string } = {
  id: 'durable',
  type: 'noul',
  prompt:
    'Is this a durable long-term preference or fact worth remembering across sessions, as opposed to a transient instruction?',
};

const VERDICT_QUESTION: { id: string; type: 'choice'; prompt: string; options: string[] } = {
  id: 'verdict',
  type: 'choice',
  prompt: 'What should happen to this memory candidate?',
  options: ['save', 'discard', 'ask'],
};

type JevVerdict = {
  verdict: 'save' | 'discard' | 'ask';
  durable: number;
  confidence: number;
} | null;

/** Ask Jev the two typed questions. null = Jev unavailable OR malformed
 * answer — both are "do not decide on this", never a save. */
async function askJev(
  candidate: { title: string; content: string; kind: MemoryKind },
  policy: TriagePolicy,
  jevOptions: TriageJevOptions | undefined,
): Promise<{ verdict: JevVerdict; raw: unknown }> {
  let response: Awaited<ReturnType<typeof systemOne>>;
  try {
    response = await systemOne(
      { title: candidate.title, content: candidate.content, kind: candidate.kind },
      [DURABLE_QUESTION, VERDICT_QUESTION],
      { ...jevOptions, timeoutMs: jevOptions?.timeoutMs ?? policy.jev.timeoutMs },
    );
  } catch {
    response = null;
  }
  if (!response) return { verdict: null, raw: null };
  const answers = new Map(response.answers.map((answer) => [answer.id, answer]));
  const durableAnswer = answers.get('durable');
  const verdictAnswer = answers.get('verdict');
  const durable = durableScore(durableAnswer?.value);
  const verdict = verdictAnswer?.value;
  const confidence = verdictAnswer?.probability ?? durableAnswer?.probability ?? 1;
  const validVerdict = verdict === 'save' || verdict === 'discard' || verdict === 'ask';
  if (durable === null || !validVerdict) return { verdict: null, raw: response };
  return { verdict: { verdict, durable, confidence }, raw: response };
}

function persist(
  handle: SqliteHandle,
  userId: string,
  candidate: NewMemory & { id: string },
  status: 'saved' | 'suggested',
): void {
  try {
    createMemoryStore(handle).add(userId, { ...candidate, status });
  } catch {
    /* the store is already total; this is belt and braces */
  }
}

export type TriageCandidate = NewMemory & { id: string };

/** Run one candidate through the locked pipeline. Every path writes exactly
 * one audit row; only 'save' and 'surface' touch the memories table. */
export async function triageCandidate(
  handle: SqliteHandle,
  candidate: TriageCandidate,
  ctx: TriageContext,
): Promise<TriageDecision> {
  ensureTables(handle);
  const policy = getPolicy(handle);
  const haystack = `${candidate.title}\n${candidate.content}`;

  // 1. Incognito: zero memory writes. The audit row is operational, not a memory.
  if (ctx.incognito)
    return writeAudit(handle, {
      candidateId: candidate.id,
      action: 'discard',
      rule: 'policy:incognito-no-write',
      confidence: null,
      jevRaw: null,
    });

  // 2. Credential-shaped content or the policy's secret blocklist.
  if (BUILTIN_SECRET.test(haystack) || matchesAny(policy.secretBlocklist, haystack))
    return writeAudit(handle, {
      candidateId: candidate.id,
      action: 'discard',
      rule: 'deterministic:secret-blocked',
      confidence: null,
      jevRaw: null,
    });

  // 3. Transient instruction: asked for the session, not for memory.
  if (matchesAny(policy.transientPatterns, haystack))
    return writeAudit(handle, {
      candidateId: candidate.id,
      action: 'discard',
      rule: 'deterministic:transient',
      confidence: null,
      jevRaw: null,
    });

  // 3b. Personal identifiers: never auto-saved. The candidate is surfaced for
  // the person to review — as 'suggested', never 'saved' — and the audit row
  // carries only the kinds found, never the values. Minimisation is about the
  // secondary copies: the suggested memory row is the person's own data to
  // inspect and delete; the operational audit trail keeps no identifiers.
  const pii = detectPii(haystack);
  if (pii.length > 0) {
    persist(handle, ctx.userId, candidate, 'suggested');
    return writeAudit(handle, {
      candidateId: candidate.id,
      action: 'surface',
      rule: 'deterministic:pii-review',
      confidence: null,
      jevRaw: { piiKinds: pii.map((hit) => hit.kind) },
    });
  }

  // 4. Auto-save kinds: an explicit durable preference, saved on sight.
  if (policy.autoSaveKinds.includes(candidate.kind)) {
    persist(handle, ctx.userId, candidate, 'saved');
    return writeAudit(handle, {
      candidateId: candidate.id,
      action: 'save',
      rule: 'deterministic:auto-save-kind',
      confidence: null,
      jevRaw: null,
    });
  }

  // Jev disabled by policy is not "unavailable": there is no one to ask, so
  // the candidate surfaces for the person instead of deferring forever.
  if (!policy.jev.enabled) {
    persist(handle, ctx.userId, candidate, 'suggested');
    return writeAudit(handle, {
      candidateId: candidate.id,
      action: 'surface',
      rule: 'policy:jev-disabled-surface',
      confidence: null,
      jevRaw: null,
    });
  }

  // 5. The Jev stage: Jev advises, the thresholds below decide.
  const { verdict, raw } = await askJev(candidate, policy, ctx.jevOptions);
  if (verdict) {
    const floor = policy.jev.confidenceFloor;
    if (
      verdict.verdict === 'save' &&
      verdict.durable >= policy.jev.durableThreshold &&
      verdict.confidence >= floor
    ) {
      persist(handle, ctx.userId, candidate, 'saved');
      return writeAudit(handle, {
        candidateId: candidate.id,
        action: 'save',
        rule: 'jev:save',
        confidence: verdict.confidence,
        jevRaw: raw,
      });
    }
    if (
      (verdict.verdict === 'discard' || verdict.durable <= policy.jev.discardThreshold) &&
      verdict.confidence >= floor
    )
      return writeAudit(handle, {
        candidateId: candidate.id,
        action: 'discard',
        rule: 'jev:discard',
        confidence: verdict.confidence,
        jevRaw: raw,
      });
    persist(handle, ctx.userId, candidate, 'suggested');
    return writeAudit(handle, {
      candidateId: candidate.id,
      action: 'surface',
      rule: 'jev:surface-low-confidence',
      confidence: verdict.confidence,
      jevRaw: raw,
    });
  }

  // 6. Jev unavailable (null / error / timeout / malformed answer): defer.
  // Never auto-save on fallback, never silently discard. The candidate is
  // carried in the audit row so retryDeferred can re-run this pipeline.
  return writeAudit(handle, {
    candidateId: candidate.id,
    action: 'defer',
    rule: 'fallback:deferred',
    confidence: null,
    jevRaw: {
      deferredCandidate: {
        userId: ctx.userId,
        kind: candidate.kind,
        title: candidate.title,
        content: candidate.content,
        provenance: candidate.provenance,
        source: candidate.source ?? '',
        sourceConversationId: candidate.sourceConversationId ?? null,
      },
    },
  });
}

type StoredCandidate = {
  userId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  provenance: NewMemory['provenance'];
  source: string;
  sourceConversationId: string | null;
  status: 'suggested';
};

function deferredCandidateOf(decision: TriageDecision): (StoredCandidate & { id: string }) | null {
  const raw = decision.jevRaw;
  if (!isRecord(raw) || !isRecord(raw.deferredCandidate)) return null;
  const stored = raw.deferredCandidate;
  const kind = (KINDS as string[]).includes(String(stored.kind))
    ? (stored.kind as MemoryKind)
    : null;
  if (!kind || typeof stored.content !== 'string') return null;
  if (typeof stored.userId !== 'string' || !stored.userId) return null;
  return {
    id: decision.candidateId,
    userId: stored.userId,
    kind,
    title: typeof stored.title === 'string' ? stored.title : '',
    content: stored.content,
    provenance: 'inference',
    source: typeof stored.source === 'string' ? stored.source : '',
    sourceConversationId:
      typeof stored.sourceConversationId === 'string' ? stored.sourceConversationId : null,
    status: 'suggested',
  };
}

/** Re-run 'defer' items older than the policy's deferRetryHours. An item that
 * already has a newer decision is left alone. If Jev is still unavailable the
 * item surfaces instead of deferring a second time — a defer that never
 * resolves is a silent discard, which the invariant forbids. */
export async function retryDeferred(
  handle: SqliteHandle,
  ctx: TriageContext,
): Promise<TriageDecision[]> {
  ensureTables(handle);
  const policy = getPolicy(handle);
  if (!policy.jev.enabled) return [];
  const cutoff = Date.now() - policy.deferRetryHours * 3_600_000;
  const history = listDecisions(handle, 500);
  const latest = new Map<string, TriageDecision>();
  for (const decision of history) {
    // listDecisions is newest-first, so the first row seen per candidate wins.
    if (!latest.has(decision.candidateId)) latest.set(decision.candidateId, decision);
  }
  const out: TriageDecision[] = [];
  for (const decision of history) {
    if (decision.action !== 'defer') continue;
    if (Number.isNaN(Date.parse(decision.createdAt))) continue;
    if (Date.parse(decision.createdAt) > cutoff) continue;
    if (latest.get(decision.candidateId)?.id !== decision.id) continue; // already re-triaged
    const candidate = deferredCandidateOf(decision);
    if (!candidate) continue;
    // Never re-persist another user's deferred candidate under this caller's id.
    if (candidate.userId !== ctx.userId) continue;
    const retried = await triageCandidate(handle, candidate, ctx);
    if (retried.action === 'defer') {
      // Jev still unavailable: surface rather than defer again.
      persist(handle, ctx.userId, candidate, 'suggested');
      out.push(
        writeAudit(handle, {
          candidateId: candidate.id,
          action: 'surface',
          rule: 'fallback:surface-after-retry',
          confidence: null,
          jevRaw: null,
        }),
      );
    } else {
      out.push(retried);
    }
  }
  return out;
}

/** Undo a triage decision. Only a 'save' decision flips a memory — to
 * 'rejected' — and every undo writes an audit row so the reversal is
 * itself on the record. Unknown decision ids are a no-op. */
export function undoDecision(handle: SqliteHandle, decisionId: string): void {
  ensureTables(handle);
  let decision: TriageDecision | null = null;
  try {
    const row = handle
      .prepare(
        `SELECT id, candidate_id, action, rule, confidence, jev_raw, created_at
         FROM triage_audit WHERE id = ?`,
      )
      .get(decisionId) as AuditRow | undefined;
    if (row) decision = fromRow(row);
  } catch {
    /* a store that cannot be read cannot be undone */
  }
  if (!decision) return;
  if (decision.action === 'save')
    try {
      // Ids are globally unique (mem_ + randomUUID), so the candidate id
      // addresses exactly the row this decision created.
      handle
        .prepare(
          `UPDATE memories SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'saved'`,
        )
        .run(new Date().toISOString(), decision.candidateId);
    } catch {
      /* the flip is best effort; the audit row below still records the undo */
    }
  writeAudit(handle, {
    candidateId: decision.candidateId,
    action: 'discard',
    rule: 'undo:decision-reverted',
    confidence: null,
    jevRaw: null,
  });
}
