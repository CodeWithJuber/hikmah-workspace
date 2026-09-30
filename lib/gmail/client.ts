/** The Gmail API behind an injectable fetch.
 *
 * Every call goes through the injected `fetchImpl` and the injected
 * `tokenFor` provider, so tests run this whole module against a stub and it
 * never touches a real mailbox. The one production behavior baked in: a 401
 * refreshes the token once and retries, because an access token can die
 * between the check and the call.
 */
import { base64UrlEncode, buildRawMessage, parseGmailMessage, type ReadMail } from './messages.ts';
import type { FetchLike } from './oauth.ts';

export class GmailClientError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'GmailClientError';
    this.status = status;
  }
}

export type GmailClientDeps = {
  fetchImpl: FetchLike;
  /** A live access token, refreshing as needed. Force with `forceRefresh`. */
  tokenFor: (forceRefresh?: boolean) => Promise<string>;
};

const BASE = 'https://www.googleapis.com/gmail/v1/users/me';

async function readError(response: Response): Promise<string> {
  const parsed = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  return parsed.error?.message ?? `Gmail API error ${response.status}`;
}

export function createGmailClient(deps: GmailClientDeps) {
  async function call(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const token = await deps.tokenFor(retried);
    let response: Response;
    try {
      response = await deps.fetchImpl(`${BASE}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
      });
    } catch {
      throw new GmailClientError('Could not reach the Gmail API.');
    }
    // A token can die between the freshness check and the call; one retry
    // with a forced refresh covers it, and only one, so a revoked grant
    // surfaces as an error instead of a loop.
    if (response.status === 401 && !retried) return call(path, init, true);
    return response;
  }

  return {
    /** Message ids matching the query, newest first. */
    async listMessages(options: {
      q?: string;
      maxResults?: number;
      pageToken?: string;
    }): Promise<{ messages: { id: string; threadId: string }[]; nextPageToken?: string }> {
      const params = new URLSearchParams();
      if (options.q) params.set('q', options.q);
      params.set('maxResults', String(Math.min(Math.max(options.maxResults ?? 20, 1), 100)));
      if (options.pageToken) params.set('pageToken', options.pageToken);
      const response = await call(`/messages?${params.toString()}`);
      if (!response.ok) throw new GmailClientError(await readError(response), response.status);
      const parsed = (await response.json()) as {
        messages?: { id: string; threadId: string }[];
        nextPageToken?: string;
      };
      return { messages: parsed.messages ?? [], nextPageToken: parsed.nextPageToken };
    },

    /** One message, parsed for display. */
    async getMessage(id: string): Promise<ReadMail> {
      if (!id) throw new GmailClientError('A message id is required.', 400);
      const response = await call(`/messages/${encodeURIComponent(id)}?format=full`);
      if (response.status === 404) throw new GmailClientError('That message was not found.', 404);
      if (!response.ok) throw new GmailClientError(await readError(response), response.status);
      const parsed = (await response.json()) as {
        id: string;
        threadId: string;
        snippet?: string;
        payload?: Parameters<typeof parseGmailMessage>[0]['payload'];
      };
      return parseGmailMessage(parsed);
    },

    /** Send one message. The caller owns idempotency — see gmailRequest. */
    async sendMessage(mail: {
      to: string[];
      cc?: string[];
      subject: string;
      body: string;
      inReplyTo?: string | null;
    }): Promise<{ id: string; threadId: string }> {
      const raw = base64UrlEncode(new TextEncoder().encode(buildRawMessage(mail)));
      const response = await call('/messages/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw }),
      });
      if (!response.ok) throw new GmailClientError(await readError(response), response.status);
      const parsed = (await response.json()) as { id: string; threadId: string };
      return { id: parsed.id, threadId: parsed.threadId };
    },
  };
}

export type GmailClient = ReturnType<typeof createGmailClient>;
