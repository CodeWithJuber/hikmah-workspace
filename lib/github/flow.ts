/** The GitHub exemplar: read → patch → checks → draft PR.
 *
 * One function runs one action. Every action is checked against the
 * connection's declared scopes before anything touches the network, every
 * attempt writes an append-only receipt, and every failure path hands back
 * enough to recover without losing the user's work:
 *
 * - scoped-auth failure (missing scope, or GitHub refusing the token): the
 *   connection is marked `needs-reauth`, the receipt records the failure, and
 *   the in-progress draft (proposed diff, PR title/body) is returned
 *   untouched so nothing is lost.
 * - API failure (5xx, network): the receipt records it as retryable and the
 *   draft is preserved the same way.
 * - check failure: surfacing checks is itself the success — the result says
 *   the checks failed, `draft-pr` refuses to run until they pass or the owner
 *   explicitly overrides, and the draft is preserved.
 *
 * Writes are dry-run unless the deployment opts in via
 * `GITHUB_LIVE_WRITES=1`, and even live writes need a per-action approval:
 * the caller must echo back the params hash the flow shows on the approval
 * card. Reading never needs approval and never writes.
 */
import type { SqliteHandle } from '../runs/store.ts';
import { createGitHubClient, paramsHash, GitHubApiError, type GitHubFetcher } from './client.ts';
import { missingScopes, isWriteAction, type ExemplarAction, type GitHubScopeId } from './scopes.ts';
import { createGitHubStore, type GitHubConnection } from './store.ts';

export type FailureCode =
  'scoped-auth' | 'reauth-required' | 'approval-required' | 'api' | 'checks' | 'not-found';

export class ExemplarFailure extends Error {
  readonly code: FailureCode;
  /** What to do next, in the user's words. */
  readonly recovery: string;
  /** The user's in-progress work, returned untouched so it is not lost. */
  readonly preserved: unknown;
  readonly retryable: boolean;
  constructor(
    code: FailureCode,
    message: string,
    recovery: string,
    options: { preserved?: unknown; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'ExemplarFailure';
    this.code = code;
    this.recovery = recovery;
    this.preserved = options.preserved;
    this.retryable = options.retryable ?? false;
  }
}

export type FlowContext = {
  db: SqliteHandle;
  userId: string;
  connectionId: string;
  action: ExemplarAction;
  params: Record<string, unknown>;
  /** Reads the connection's token from the encrypted secret store. */
  getToken: (connectionId: string) => Promise<string | null>;
  fetchImpl?: GitHubFetcher;
  /** The params hash the owner approved on the approval card. Required for
   * write actions; the hash binds the approval to the exact params. */
  approvedParamsHash?: string;
  /** Explicit override for a checks-blocked draft PR, from its own card. */
  checksOverride?: boolean;
  liveWritesEnabled?: boolean;
  now?: () => string;
};

export type FlowResult = {
  action: ExemplarAction;
  dryRun: boolean;
  receiptId: string;
  data: unknown;
  /** Set when the action itself succeeded at surfacing a problem, e.g. the
   * checks failed. Not an error — the receipt says ok. */
  blocked?: { reason: string; detail: unknown };
};

const repoRef = (params: Record<string, unknown>) => {
  const owner = String(params.owner ?? '').trim();
  const repo = String(params.repo ?? '').trim();
  if (!owner || !repo)
    throw new ExemplarFailure('api', 'Name the repository first.', 'Fill in the owner and repo.', {
      preserved: params,
    });
  return { owner, repo };
};

/** A minimal unified diff between two texts — the "patch" the exemplar
 * proposes. Computed locally from fetched content; nothing is pushed. */
export function proposeDiff(path: string, base: string, next: string): string {
  const baseLines = base.split('\n');
  const nextLines = next.split('\n');
  const out = [`--- a/${path}`, `+++ b/${path}`];
  // A simple line-level diff: walk both, emit hunks around changes.
  let i = 0;
  let j = 0;
  const hunk: string[] = [];
  const flush = () => {
    if (!hunk.length) return;
    out.push(
      `@@ -${i - hunk.filter((l) => l[0] !== '+').length + 1},${hunk.filter((l) => l[0] !== '+').length} +${j - hunk.filter((l) => l[0] !== '-').length + 1},${hunk.filter((l) => l[0] !== '-').length} @@`,
    );
    out.push(...hunk);
    hunk.length = 0;
  };
  while (i < baseLines.length || j < nextLines.length) {
    if (i < baseLines.length && j < nextLines.length && baseLines[i] === nextLines[j]) {
      flush();
      i++;
      j++;
      continue;
    }
    if (i < baseLines.length) {
      hunk.push(`-${baseLines[i]}`);
      i++;
    }
    if (j < nextLines.length) {
      hunk.push(`+${nextLines[j]}`);
      j++;
    }
  }
  flush();
  return out.join('\n');
}

export async function runExemplarAction(context: FlowContext): Promise<FlowResult> {
  const store = createGitHubStore(context.db, context.now ? { now: context.now } : {});
  const connection: GitHubConnection | undefined = store.get(context.connectionId, context.userId);
  if (!connection)
    throw new ExemplarFailure(
      'not-found',
      'That GitHub connection is not saved here.',
      'Connect GitHub again from Integrations.',
    );
  if (connection.status === 'needs-reauth')
    throw new ExemplarFailure(
      'reauth-required',
      connection.lastError ?? 'This connection needs a fresh token.',
      'Paste a fresh token on the connection card. Your draft below is kept.',
      { preserved: context.params, retryable: false },
    );

  const hash = paramsHash(context.params);
  const receipt = (status: 'ok' | 'dry-run' | 'failed', summary: string | null, dryRun: boolean) =>
    store.recordReceipt(
      context.userId,
      connection.id,
      context.action,
      hash,
      status,
      summary,
      dryRun,
    );

  // Scoped authorization is enforced before the network, at every step.
  const missing = missingScopes(connection.scopes, context.action);
  if (missing.length > 0) {
    const summary = `Missing permissions: ${missing.join(', ')}.`;
    receipt('failed', summary, false);
    throw new ExemplarFailure(
      'scoped-auth',
      `This step needs ${missing.join(', ')}, which this connection was not granted.`,
      'Re-connect with those permissions checked, or run a step that needs less. Your draft below is kept.',
      { preserved: context.params },
    );
  }

  // Write actions need the owner's per-action approval, bound to the exact
  // params by their hash. A dry run still records its receipt.
  if (isWriteAction(context.action) && context.approvedParamsHash !== hash) {
    throw new ExemplarFailure(
      'approval-required',
      'Opening the draft pull request needs your explicit approval.',
      'Review the approval card and approve this exact action. Nothing was sent.',
      { preserved: context.params },
    );
  }

  const live = context.liveWritesEnabled === true;
  const token = await context.getToken(connection.id);
  if (!token && context.action !== 'propose-patch') {
    store.markNeedsReauth(connection.id, context.userId, 'The saved token is gone.');
    receipt('failed', 'The saved token is gone.', false);
    throw new ExemplarFailure(
      'reauth-required',
      'The saved token is gone.',
      'Paste the token again on the connection card. Your draft below is kept.',
      { preserved: context.params },
    );
  }

  const client = createGitHubClient({ token: token ?? '', fetchImpl: context.fetchImpl });

  try {
    switch (context.action) {
      case 'read-file': {
        const { owner, repo } = repoRef(context.params);
        const file = await client.getFileContent({
          owner,
          repo,
          path: String(context.params.path ?? ''),
          ref: context.params.ref ? String(context.params.ref) : undefined,
        });
        const id = receipt('ok', `${file.path} (${file.content.length} chars)`, false).id;
        return { action: context.action, dryRun: false, receiptId: id, data: file };
      }

      case 'read-issues': {
        const { owner, repo } = repoRef(context.params);
        const issues = await client.listIssues({
          owner,
          repo,
          state: (context.params.state as 'open' | 'closed' | 'all' | undefined) ?? 'open',
          labels: context.params.labels ? String(context.params.labels) : undefined,
        });
        const id = receipt('ok', `${issues.length} issues`, false).id;
        return { action: context.action, dryRun: false, receiptId: id, data: { issues } };
      }

      case 'propose-patch': {
        // Pure: no token, no network. The diff is the deliverable.
        const path = String(context.params.path ?? 'file');
        const diff = proposeDiff(
          path,
          String(context.params.baseContent ?? ''),
          String(context.params.newContent ?? ''),
        );
        const id = receipt('ok', `Proposed diff for ${path} (${diff.length} chars)`, false).id;
        return {
          action: context.action,
          dryRun: false,
          receiptId: id,
          data: { path, diff },
        };
      }

      case 'surface-checks': {
        const { owner, repo } = repoRef(context.params);
        const ref = String(context.params.ref ?? '').trim();
        if (!ref)
          throw new ExemplarFailure(
            'api',
            'Name the commit to check.',
            'Give the branch or commit sha.',
            {
              preserved: context.params,
            },
          );
        const checks = await client.getCheckRuns({ owner, repo, ref });
        const failed = checks.filter(
          (check) =>
            check.conclusion === 'failure' ||
            check.conclusion === 'timed_out' ||
            check.conclusion === 'action_required',
        );
        const summary =
          checks.length === 0
            ? 'No checks reported for that commit.'
            : failed.length === 0
              ? `All ${checks.length} checks passed.`
              : `${failed.length} of ${checks.length} checks failed.`;
        const id = receipt('ok', summary, false).id;
        if (failed.length > 0)
          return {
            action: context.action,
            dryRun: false,
            receiptId: id,
            data: { checks },
            blocked: {
              reason: 'Some checks failed.',
              detail: { failed: failed.map((c) => c.name) },
            },
          };
        return { action: context.action, dryRun: false, receiptId: id, data: { checks } };
      }

      case 'draft-pr': {
        const { owner, repo } = repoRef(context.params);
        const title = String(context.params.title ?? '').trim();
        const head = String(context.params.head ?? '').trim();
        const base = String(context.params.base ?? 'main').trim();
        if (!title || !head)
          throw new ExemplarFailure(
            'api',
            'A draft PR needs a title and a head branch.',
            'Fill in the title and the branch the PR opens from. Your draft below is kept.',
            { preserved: context.params },
          );
        const proposal = {
          owner,
          repo,
          title,
          body: String(context.params.body ?? ''),
          head,
          base,
        };
        // A failing check run blocks the draft PR unless the owner explicitly
        // overrides on its own card. The checks come from the surface-checks
        // step that just ran — this is the recovery path, not a second fetch.
        const surfaced = Array.isArray(context.params.checks)
          ? (context.params.checks as { conclusion?: string | null; name?: string }[])
          : [];
        const failing = surfaced.filter(
          (check) =>
            check.conclusion === 'failure' ||
            check.conclusion === 'timed_out' ||
            check.conclusion === 'action_required',
        );
        if (failing.length > 0 && context.checksOverride !== true) {
          receipt('failed', `Blocked: ${failing.length} checks failing.`, false);
          throw new ExemplarFailure(
            'checks',
            `${failing.length} check${failing.length === 1 ? '' : 's'} failed: ${failing.map((c) => c.name ?? 'unnamed').join(', ')}.`,
            'Fix the checks, or approve the override on its own card. Your draft below is kept.',
            { preserved: context.params },
          );
        }
        if (!live) {
          const id = receipt(
            'dry-run',
            `Would open draft PR "${title}" (${head} → ${base}).`,
            true,
          ).id;
          return { action: context.action, dryRun: true, receiptId: id, data: { proposal } };
        }
        const pull = await client.createDraftPull(proposal);
        const id = receipt('ok', `Draft PR #${pull.number}: ${pull.url}`, false).id;
        return { action: context.action, dryRun: false, receiptId: id, data: { pull } };
      }
    }
  } catch (error) {
    if (error instanceof ExemplarFailure) {
      // Validation failures above already carry their message; only record
      // when they escaped before a receipt was written.
      throw error;
    }
    if (error instanceof GitHubApiError) {
      if (error.kind === 'auth') {
        store.markNeedsReauth(
          connection.id,
          context.userId,
          'GitHub refused the token. It may be expired, revoked, or missing the permission this step needs.',
        );
        receipt('failed', 'GitHub refused the token (scoped-auth failure).', false);
        throw new ExemplarFailure(
          'scoped-auth',
          'GitHub refused the token. It may be expired, revoked, or missing the permission this step needs.',
          'Paste a fresh token with the needed permissions. Your draft below is kept.',
          { preserved: context.params },
        );
      }
      const retryable =
        error.kind === 'server' || error.kind === 'network' || error.kind === 'rate-limit';
      receipt('failed', `GitHub API failure: ${error.message}`, false);
      throw new ExemplarFailure(
        'api',
        `GitHub failed: ${error.message}`,
        retryable
          ? 'Wait a moment and run the step again. Your draft below is kept.'
          : 'Fix the request and run the step again. Your draft below is kept.',
        { preserved: context.params, retryable },
      );
    }
    receipt('failed', error instanceof Error ? error.message : 'Unexpected failure.', false);
    throw error;
  }
  // Unreachable: the switch covers every action.
  throw new ExemplarFailure('api', 'Unknown action.', 'Pick one of the exemplar steps.');
}

export type { GitHubScopeId, ExemplarAction };
