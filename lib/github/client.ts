/** A small, injectable GitHub REST client.
 *
 * `fetchImpl` is a parameter, not a global, so every call in the test suite
 * runs against a stub and the real API is never touched by a test. The client
 * knows nothing about connections, scopes or receipts — it only translates
 * between the exemplar's verbs and GitHub's endpoints and classifies
 * failures so the flow can recover cleanly.
 */
import { createHash } from 'node:crypto';

const API = 'https://api.github.com';

export type GitHubFailureKind = 'auth' | 'rate-limit' | 'not-found' | 'server' | 'network';

export class GitHubApiError extends Error {
  readonly kind: GitHubFailureKind;
  readonly status: number | null;
  constructor(kind: GitHubFailureKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'GitHubApiError';
    this.kind = kind;
    this.status = status;
  }
}

export type GitHubFetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export type RepoRef = { owner: string; repo: string };

export type GitHubFile = { path: string; sha: string; content: string; truncated: boolean };

export type GitHubIssue = {
  number: number;
  title: string;
  state: string;
  labels: string[];
  url: string;
};

export type GitHubCheck = {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
};

export type DraftPullRequest = {
  number: number;
  url: string;
  head: string;
  base: string;
  draft: boolean;
};

const userAgent = { 'user-agent': 'hikmah-workspace/1.0' };

/** sha256 of the canonical params behind a call — what receipts store so an
 * action is verifiable without keeping the params themselves. */
export function paramsHash(params: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(params ?? null))
    .digest('hex');
}

export function createGitHubClient(options: { token: string; fetchImpl?: GitHubFetcher }) {
  const fetchImpl: GitHubFetcher = options.fetchImpl ?? (fetch as unknown as GitHubFetcher);
  const authHeaders = {
    authorization: `Bearer ${options.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...userAgent,
  };

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method,
        headers: body ? { ...authHeaders, 'content-type': 'application/json' } : authHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new GitHubApiError(
        'network',
        `GitHub did not answer: ${error instanceof Error ? error.message : 'network error'}.`,
      );
    }
    if (response.ok) return (await response.json()) as T;
    const remaining = response.headers.get('x-ratelimit-remaining');
    const payload = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403)
      throw new GitHubApiError(
        'auth',
        'GitHub refused the token. It may be expired, revoked, or missing the permission this step needs.',
        response.status,
      );
    if (response.status === 404)
      throw new GitHubApiError(
        'not-found',
        'GitHub has nothing at that address — check the owner, repo, and path.',
        404,
      );
    if (response.status === 429 || remaining === '0')
      throw new GitHubApiError(
        'rate-limit',
        'GitHub rate-limited the request. Wait a minute and try again.',
        response.status,
      );
    if (response.status >= 500)
      throw new GitHubApiError(
        'server',
        `GitHub failed (${response.status}). The request is safe to retry.`,
        response.status,
      );
    throw new GitHubApiError(
      'server',
      `GitHub answered ${response.status}: ${payload.slice(0, 200) || 'no detail'}.`,
      response.status,
    );
  }

  return {
    /** Confirm the token works and learn who it belongs to. */
    async verifyToken(): Promise<{ login: string }> {
      const user = await request<{ login?: string }>('GET', '/user');
      if (!user.login) throw new GitHubApiError('auth', 'GitHub did not name the token owner.');
      return { login: user.login };
    },

    /** Fetch a file's decoded content at a ref (branch, tag or sha). */
    async getFileContent(ref: RepoRef & { path: string; ref?: string }): Promise<GitHubFile> {
      const query = ref.ref ? `?ref=${encodeURIComponent(ref.ref)}` : '';
      const file = await request<{
        type?: string;
        path?: string;
        sha?: string;
        content?: string;
        truncated?: boolean;
        encoding?: string;
      }>(
        'GET',
        `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/contents/${ref.path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}${query}`,
      );
      if (file.type !== 'file' || typeof file.content !== 'string' || file.encoding !== 'base64')
        throw new GitHubApiError('not-found', 'That path is not a file GitHub will hand over.');
      return {
        path: file.path ?? ref.path,
        sha: file.sha ?? '',
        content: Buffer.from(file.content, 'base64').toString('utf8'),
        truncated: file.truncated === true,
      };
    },

    /** List issues on a repo, newest first. */
    async listIssues(
      ref: RepoRef & { state?: 'open' | 'closed' | 'all'; labels?: string },
    ): Promise<GitHubIssue[]> {
      const query = new URLSearchParams({ per_page: '20' });
      if (ref.state) query.set('state', ref.state);
      if (ref.labels) query.set('labels', ref.labels);
      const issues = await request<
        { number: number; title: string; state: string; html_url: string; labels: unknown[] }[]
      >(
        'GET',
        `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues?${query}`,
      );
      return issues
        .filter((issue) => typeof issue.number === 'number')
        .map((issue) => ({
          number: issue.number,
          title: issue.title ?? '',
          state: issue.state ?? '',
          labels: issue.labels
            .map((label) =>
              typeof label === 'string' ? label : (label as { name?: string })?.name,
            )
            .filter((name): name is string => typeof name === 'string'),
          url: issue.html_url ?? '',
        }));
    },

    /** The check runs GitHub reports for a commit sha. */
    async getCheckRuns(ref: RepoRef & { ref: string }): Promise<GitHubCheck[]> {
      const runs = await request<{
        check_runs?: {
          name?: string;
          status?: string;
          conclusion?: string | null;
          html_url?: string;
        }[];
      }>(
        'GET',
        `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/commits/${encodeURIComponent(ref.ref)}/check-runs`,
      );
      return (runs.check_runs ?? []).map((run) => ({
        name: run.name ?? 'unnamed check',
        status: run.status ?? 'unknown',
        conclusion: run.conclusion ?? null,
        url: run.html_url ?? '',
      }));
    },

    /** Open a draft pull request. This is the exemplar's only write. */
    async createDraftPull(
      ref: RepoRef & { title: string; body: string; head: string; base: string },
    ): Promise<DraftPullRequest> {
      const pull = await request<{
        number?: number;
        html_url?: string;
        head?: { ref?: string };
        base?: { ref?: string };
        draft?: boolean;
      }>('POST', `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls`, {
        title: ref.title,
        body: ref.body,
        head: ref.head,
        base: ref.base,
        draft: true,
      });
      if (typeof pull.number !== 'number')
        throw new GitHubApiError('server', 'GitHub did not return a pull request number.');
      return {
        number: pull.number,
        url: pull.html_url ?? '',
        head: pull.head?.ref ?? ref.head,
        base: pull.base?.ref ?? ref.base,
        draft: pull.draft !== false,
      };
    },
  };
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;
