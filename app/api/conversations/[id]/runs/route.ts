import { validateUIMessages, type UIMessage } from 'ai';
import { getChatGPTUser } from '../../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { ChatRequestError, assertSameOrigin, parseChatRequest } from '@/lib/ai/chat-request';
import { conversationTitle } from '@/lib/chat/title';
import { newMessageId, newRunId, runService } from '@/lib/runs/service';
import { createSecretStore } from '@/server/workspace-secrets.mjs';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** At most one run in flight per conversation, and this many per owner, so a
 * stuck or looping client cannot queue work without bound. */
const MAX_ACTIVE_RUNS = 3;

/** Does this message carry a decision for a tool that was waiting on one? */
function hasApprovalResponse(message: UIMessage): boolean {
  return message.parts.some((part) => (part as { state?: string }).state === 'approval-responded');
}

/**
 * Which run, if any, is currently in flight for this conversation.
 *
 * A reload knows the conversation from the URL but not the run, so it cannot
 * rejoin an answer that is still being written without asking. Authenticated
 * the same way the stream is, and for the same reason: a browser sends no
 * Origin on a same-origin GET, so requiring one would reject every reload.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);

  const { id: conversationId } = await context.params;
  const store = runService().store;
  const runId = store.activeForConversation(conversationId);
  // Ownership is checked on the run rather than the conversation id, so naming
  // someone else's conversation reveals nothing about whether it exists.
  const run = runId ? store.getRun(runId) : null;
  if (!run || run.user_id !== user.userId) return Response.json({ runId: null }, { headers });
  return Response.json({ runId: run.id, status: run.status }, { headers });
}

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

  // The conversation id comes from the client, so an existing row has to be
  // checked rather than assumed: without this, naming someone else's
  // conversation would append to it. Refused as "not found" so the reply does
  // not confirm that the conversation exists.
  const existing = store.getConversation(conversationId);
  if (existing && existing.user_id !== user.userId) return fail('Conversation not found.', 404);
  if (!existing)
    try {
      store.createConversation({ id: conversationId, userId: user.userId, model: parsed.model });
    } catch {
      /* already created by a concurrent request */
    }

  const incomingMessage = messages.at(-1);

  // A run paused on an approval is answered by re-sending the assistant message
  // with the decision filled in. That is a resume, not a new run: treating it as
  // one would refuse the answer and strand the run it was meant to release.
  const already = store.activeForConversation(conversationId);
  if (already) {
    const paused = store.getRun(already);
    if (
      paused?.status === 'waiting_approval' &&
      incomingMessage?.role === 'assistant' &&
      hasApprovalResponse(incomingMessage)
    ) {
      store.replaceMessage(conversationId, {
        id: incomingMessage.id,
        parts: incomingMessage.parts,
      });
      // False when the run has moved on, which absorbs a duplicate answer
      // rather than starting a second run over the same conversation.
      if (store.requeueApproved(already)) void worker.tick();
      return Response.json({ runId: already, conversationId, resumed: true }, { headers });
    }
    return Response.json(
      { runId: already, conversationId, alreadyRunning: true },
      { headers, status: 409 },
    );
  }
  if (store.countActive(user.userId) >= MAX_ACTIVE_RUNS)
    return fail('Too many runs are already in progress. Wait for one to finish.', 429);

  const incoming = incomingMessage;
  if (!incoming) return fail('Send a message to start the run.', 400);
  store.appendMessage(conversationId, {
    id: incoming.id ?? newMessageId(),
    role: incoming.role,
    parts: incoming.parts,
    metadata: undefined,
  });
  // Name it from the message that started it. setTitle only writes when the
  // title is still empty, so a later message cannot rename a conversation the
  // owner has been finding in the list by that name.
  if (incoming.role === 'user') {
    const title = conversationTitle(incoming.parts);
    if (title) store.setTitle(conversationId, title);
  }

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
        enabledTools: parsed.enabledTools,
        compare: parsed.compare,
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
