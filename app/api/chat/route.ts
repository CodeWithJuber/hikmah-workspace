import { createAgentUIStreamResponse, validateUIMessages, type UIMessage } from 'ai';
import { getChatGPTUser } from '../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { EndpointError } from '@/lib/ai/endpoint';
import { buildRunAgent } from '@/lib/ai/run-agent';
import { initialModel } from '@/lib/playground/session';
import { createSecretStore } from '@/server/workspace-secrets.mjs';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** Requests carrying a body must prove they came from this app, not another
 * origin riding the owner's session cookie. */
function assertSameOrigin(request: Request) {
  const expected = publicOrigin(request);
  const origin = request.headers.get('origin');
  if (!origin || origin !== expected) throw new EndpointError('A same-origin request is required.');
}

/**
 * Run one turn of the agent loop on the server and stream it back.
 *
 * The loop used to live in the browser tab, which meant closing the tab killed
 * the run and every provider key had to be reachable from page memory. Here the
 * tab is only a view: it sends messages and renders the stream.
 *
 * This route is still request-scoped, so a closed tab still ends this run. The
 * durable worker that removes that limitation reuses buildRunAgent unchanged.
 */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  try {
    assertSameOrigin(request);
  } catch {
    return fail('Use chat from your signed-in workspace.', 403);
  }

  let body: {
    messages?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    freeOnly?: unknown;
    apiKeySecret?: unknown;
    instructions?: unknown;
    maxSteps?: unknown;
    disabledTools?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return fail('Expected a JSON request body.', 400);
  }

  if (typeof body.baseUrl !== 'string' || typeof body.model !== 'string')
    return fail('Choose a provider and a model.', 400);
  if (typeof body.instructions !== 'string' || !body.instructions.trim())
    return fail('Missing system instructions for this run.', 400);

  // The key is resolved here and never returned: the browser only ever holds
  // the *name* of a saved secret.
  let apiKey = '';
  const secretName = typeof body.apiKeySecret === 'string' ? body.apiKeySecret : '';
  if (secretName) {
    try {
      apiKey = await createSecretStore().resolve(user.userId, secretName, 'provider:' + body.model);
    } catch {
      apiKey = '';
    }
  }
  if (!apiKey) apiKey = process.env.HIKMAH_PROVIDER_KEY ?? '';

  let messages: UIMessage[];
  try {
    messages = await validateUIMessages({ messages: body.messages as UIMessage[] });
  } catch {
    return fail('The conversation could not be read. Reload and try again.', 400);
  }
  if (!messages.length) return fail('Send a message to start the run.', 400);

  try {
    const agent = buildRunAgent({
      provider: {
        baseUrl: body.baseUrl,
        model: body.model,
        apiKey,
        freeOnly: body.freeOnly === true,
        referer: publicOrigin(request),
        title: 'Hikmah Workspace',
      },
      instructions: body.instructions,
      maxSteps: typeof body.maxSteps === 'number' ? body.maxSteps : undefined,
      meaningModel: initialModel,
      disabledTools: Array.isArray(body.disabledTools)
        ? body.disabledTools.filter((t): t is string => typeof t === 'string')
        : [],
      savedSearchKey: () =>
        createSecretStore().resolve(user.userId, 'BRAVE_SEARCH_API_KEY', 'search:brave'),
      signal: request.signal,
    });

    return await createAgentUIStreamResponse({
      agent,
      uiMessages: messages,
      abortSignal: request.signal,
      headers,
      // Usage rides along so the token and cost display shows a real number
      // rather than an estimate.
      messageMetadata: ({ part }: { part: { type: string; totalUsage?: unknown } }) =>
        part.type === 'finish' ? { totalUsage: part.totalUsage, model: body.model } : undefined,
      // Without this, v7 redacts error text and the reader sees nothing
      // actionable. Provider prose is still never forwarded verbatim: these are
      // this app's own messages, from the endpoint policy and the watchdog.
      onError: (error: unknown) => (error instanceof Error ? error.message : 'The run failed.'),
    });
  } catch (error) {
    if (error instanceof EndpointError) return fail(error.message, 400);
    return fail(error instanceof Error ? error.message : 'The run could not be started.', 502);
  }
}
