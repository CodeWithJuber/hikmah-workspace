import { validateUIMessages, type UIMessage } from 'ai';
import { getChatGPTUser } from '../../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { ChatRequestError, assertSameOrigin, parseChatRequest } from '@/lib/ai/chat-request';
import { newMessageId, newRunId, runService } from '@/lib/runs/service';
import { createSecretStore } from '@/server/workspace-secrets.mjs';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** At most one run in flight per conversation, and this many per owner, so a
 * stuck or looping client cannot queue work without bound. */
const MAX_ACTIVE_RUNS = 3;

/**
 * Queue a run for this conversation and return immediately.
 *
 * The response is the run id, not the answer. The client then tails
 * /api/runs/[id]/stream, which it can leave and rejoin: the run belongs to the
 * server, so closing the tab no longer ends the work.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
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

  const { id: conversationId } = await context.params;
  const worker = runService();
  const store = worker.store;

  let messages: UIMessage[];
  try {
    messages = await validateUIMessages({ messages: parsed.messages as UIMessage[] });
  } catch {
    return fail('The conversation could not be read. Reload and try again.', 400);
  }

  // The conversation may not exist yet: the first message creates it.
  if (!store.listMessages(conversationId).length)
    try {
      store.createConversation({ id: conversationId, userId: user.userId, model: parsed.model });
    } catch {
      /* already created by a concurrent request */
    }

  // One run per conversation keeps two tabs from answering the same thread at
  // once; the per-owner cap bounds the queue if a client retries in a loop.
  const already = store.activeForConversation(conversationId);
  if (already)
    return Response.json(
      { runId: already, conversationId, alreadyRunning: true },
      { headers, status: 409 },
    );
  if (store.countActive(user.userId) >= MAX_ACTIVE_RUNS)
    return fail('Too many runs are already in progress. Wait for one to finish.', 429);

  const incoming = messages.at(-1);
  if (!incoming) return fail('Send a message to start the run.', 400);
  store.appendMessage(conversationId, {
    id: incoming.id ?? newMessageId(),
    role: incoming.role,
    parts: incoming.parts,
    metadata: undefined,
  });

  // The key is resolved once, here, and stored on the run so the worker can
  // drive it after this request has gone. It is never returned to the browser.
  let apiKey = '';
  if (parsed.apiKeySecret) {
    try {
      apiKey = await createSecretStore().resolve(
        user.userId,
        parsed.apiKeySecret,
        'provider:' + parsed.model,
      );
    } catch {
      apiKey = '';
    }
  }
  if (!apiKey) apiKey = process.env.HIKMAH_PROVIDER_KEY ?? '';

  const runId = newRunId();
  try {
    store.createRun({
      id: runId,
      conversationId,
      userId: user.userId,
      config: {
        baseUrl: parsed.baseUrl,
        model: parsed.model,
        freeOnly: parsed.freeOnly,
        apiKey,
        instructions: parsed.instructions,
        maxSteps: parsed.maxSteps,
        disabledTools: parsed.disabledTools,
      },
    });
  } catch {
    return fail('The run could not be queued. Try again.', 503);
  }

  // Nudge the loop rather than waiting for the next poll, so the first token
  // arrives as quickly as it did when the browser drove the run.
  void worker.tick();

  return Response.json({ runId, conversationId }, { headers, status: 202 });
}
