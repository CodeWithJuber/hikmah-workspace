import { createAgentUIStreamResponse, validateUIMessages, type UIMessage } from 'ai';
import { getChatGPTUser } from '../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { EndpointError } from '@/lib/ai/endpoint';
import { ChatRequestError, assertSameOrigin, parseChatRequest } from '@/lib/ai/chat-request';
import { buildRunAgent } from '@/lib/ai/run-agent';
import { sshRunContext } from '@/lib/ssh/run-context';
import { mcpForUser } from '@/lib/mcp/app-context';
import { workbenchReady } from '@/lib/ssh/run-context';
import { initialModel } from '@/lib/playground/session';
import { createSecretStore } from '@/server/workspace-secrets.mjs';
import { providerDestination } from '@/lib/ai/endpoint';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/**
 * A stable key for this conversation's shell session.
 *
 * This route is request-scoped and carries no conversation row, so the owner is
 * the grouping it does have: their commands share one working directory, which
 * is what someone using a single chat window expects. The durable path uses the
 * real conversation id instead.
 */
const chatSessionId = (request: Request, userId: string) =>
  'chat:' + userId + ':' + (request.headers.get('x-hikmah-conversation') ?? 'default');

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
    assertSameOrigin(request, publicOrigin(request));
  } catch (error) {
    if (error instanceof ChatRequestError) return fail(error.message, error.status);
    throw error;
  }

  let parsed;
  try {
    parsed = parseChatRequest(await request.json().catch(() => null));
  } catch (error) {
    if (error instanceof ChatRequestError) return fail(error.message, error.status);
    return fail('Expected a JSON request body.', 400);
  }

  // The key is resolved here and never returned: the browser only ever holds
  // the name of a saved secret.
  let apiKey = '';
  if (parsed.apiKeySecret) {
    try {
      apiKey = await createSecretStore().resolve(
        user.userId,
        parsed.apiKeySecret,
        providerDestination(parsed.baseUrl),
      );
    } catch {
      apiKey = '';
    }
  }
  if (!apiKey) apiKey = process.env.HIKMAH_PROVIDER_KEY ?? '';

  let messages: UIMessage[];
  try {
    messages = await validateUIMessages({ messages: parsed.messages as UIMessage[] });
  } catch {
    return fail('The conversation could not be read. Reload and try again.', 400);
  }
  if (!messages.length) return fail('Send a message to start the run.', 400);

  try {
    // Connected once per turn, then released in the finally below: a server's
    // tool descriptions are part of the prompt, so they are re-read and
    // re-checked rather than cached into a state nobody re-approves.
    const mcp = await mcpForUser(user.userId, request.signal);
    const agent = buildRunAgent({
      provider: {
        baseUrl: parsed.baseUrl,
        model: parsed.model,
        apiKey,
        freeOnly: parsed.freeOnly,
        referer: publicOrigin(request),
        title: 'Hikmah Workspace',
      },
      instructions: parsed.instructions,
      maxSteps: parsed.maxSteps,
      meaningModel: initialModel,
      disabledTools: parsed.disabledTools,
      savedSearchKey: () =>
        createSecretStore().resolve(user.userId, 'BRAVE_SEARCH_API_KEY', 'search:brave'),
      // Undefined when this deployment has no workbench, which keeps ssh_exec
      // out of the tool set rather than offering one that fails on every call.
      ssh: sshRunContext(user.userId),
      // The conversation id groups commands into one shell session, so `cd`
      // carries between calls the way it does in a terminal.
      shell: { conversationId: chatSessionId(request, user.userId), available: workbenchReady() },
      mcp,
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
        part.type === 'finish' ? { totalUsage: part.totalUsage, model: parsed.model } : undefined,
      // Without this, v7 redacts error text and the reader sees nothing
      // actionable. Provider prose is still never forwarded verbatim: these are
      // this app's own messages, from the endpoint policy and the watchdog.
      onError: (error: unknown) => (error instanceof Error ? error.message : 'The run failed.'),
      // The stream outlives this function, so the MCP clients are released when
      // it ends rather than in a finally that would run mid-run.
      onEnd: () => {
        void mcp.close();
      },
    });
  } catch (error) {
    if (error instanceof EndpointError) return fail(error.message, 400);
    return fail(error instanceof Error ? error.message : 'The run could not be started.', 502);
  }
}
