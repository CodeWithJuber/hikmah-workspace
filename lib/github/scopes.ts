/** The scoped authorization model for the GitHub exemplar.
 *
 * The owner pastes a fine-grained personal access token they create on
 * github.com with exactly the permissions shown on the connect screen. The
 * token is stored in the encrypted secret store bound to the connection id
 * (`github:<connectionId>`), and every exemplar action declares the
 * permissions it needs; the flow refuses to act when the connection does not
 * carry them.
 *
 * Only `draft-pr` writes anything to GitHub, and even it is dry-run unless the
 * deployment opts in. `propose-patch` builds a diff locally from what
 * `read-file` fetched — proposing never needs a write permission.
 */

/** A fine-grained PAT permission the connection may declare, with the words
 * the connect screen shows next to it. The owner picks these on github.com
 * when they create the token; what they pick is what the connection has. */
export const GITHUB_SCOPES = [
  {
    id: 'contents:read',
    label: 'Contents — read',
    description: 'Fetch file contents from repositories the token can see.',
  },
  {
    id: 'issues:read',
    label: 'Issues — read',
    description: 'List and read issues and their comments.',
  },
  {
    id: 'pull_requests:read',
    label: 'Pull requests — read',
    description: 'Read pull requests and the checks attached to them.',
  },
  {
    id: 'checks:read',
    label: 'Checks — read',
    description: 'Read check-run results (CI status) for a commit.',
  },
  {
    id: 'contents:write',
    label: 'Contents — write',
    description: 'Create branches and push commits. Only used by the draft-PR step.',
  },
  {
    id: 'pull_requests:write',
    label: 'Pull requests — write',
    description: 'Open draft pull requests. Only used by the draft-PR step.',
  },
] as const;

export type GitHubScopeId = (typeof GITHUB_SCOPES)[number]['id'];

/** The exemplar's actions, in flow order. */
export const EXEMPLAR_ACTIONS = [
  'read-file',
  'read-issues',
  'propose-patch',
  'surface-checks',
  'draft-pr',
] as const;

export type ExemplarAction = (typeof EXEMPLAR_ACTIONS)[number];

/** The permissions each action needs. Nothing here is aspirational: the flow
 * checks these against the connection's declared scopes before it touches the
 * network, and a missing one is a scoped-auth failure, not an API surprise. */
const ACTION_SCOPES: Record<ExemplarAction, GitHubScopeId[]> = {
  'read-file': ['contents:read'],
  'read-issues': ['issues:read'],
  // A proposal is computed locally from fetched content; it writes nothing.
  'propose-patch': ['contents:read'],
  'surface-checks': ['pull_requests:read', 'checks:read'],
  'draft-pr': ['contents:write', 'pull_requests:write'],
};

/** Actions that change something on GitHub. Read-only actions never need an
 * approval card; write actions always do, one approval per action. */
export const isWriteAction = (action: ExemplarAction): boolean => action === 'draft-pr';

/** Which of an action's scopes the connection does not declare. Empty means
 * the action may proceed. */
export function missingScopes(
  declared: readonly string[],
  action: ExemplarAction,
): GitHubScopeId[] {
  const have = new Set(declared);
  return ACTION_SCOPES[action].filter((scope) => !have.has(scope));
}

/** Parse the scope list the owner declares at connect time. Anything not in
 * the catalogue is rejected rather than carried: a typo in a scope name must
 * not silently become a permission nobody displayed. */
export function parseDeclaredScopes(raw: unknown): GitHubScopeId[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new GitHubScopeError('Choose at least one permission for the token.');
  const known = new Set<string>(GITHUB_SCOPES.map((scope) => scope.id));
  const seen = new Set<GitHubScopeId>();
  for (const item of raw) {
    if (typeof item !== 'string' || !known.has(item))
      throw new GitHubScopeError(`"${String(item)}" is not a permission this screen offers.`);
    seen.add(item as GitHubScopeId);
  }
  return [...seen];
}

export class GitHubScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubScopeError';
  }
}
