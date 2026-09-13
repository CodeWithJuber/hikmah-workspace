import { validateUIMessages, type UIMessage } from 'ai';
import { getChatGPTUser } from '../../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { ChatRequestError, assertSameOrigin, parseChatRequest } from '@/lib/ai/chat-request';
import { conversationTitle } from '@/lib/chat/title';
import { releases } from '@/lib/runs/resume';
import { newMessageId, newRunId, runService } from '@/lib/runs/service';
import { createSecretStore } from '@/server/workspace-secrets.mjs';
import { needsKey, providerDestination } from '@/lib/ai/endpoint';
import { billingStore, entitlementsForUser } from '@/lib/billing/server';
import { refusal, runAccess } from '@/lib/billing/access';
import { getStorage } from '@/server/storage.mjs';
import { createChatSettingsStore } from '@/lib/chat/settings-store';
import { createActiveCheckpointStore } from '@/lib/context-model/active-store';
import { loadFieldForUser } from '@/lib/context-model/server';
import { buildContextBrief } from '@/lib/context-model/run-brief';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** At most one run in flight per conversation, and this many per owner, so a
 * stuck or looping client cannot queue work without bound. */
const MAX_ACTIVE_RUNS = 3;

/** The composer inlines an attachment as a data URL rather than uploading it,
 * so a message body is now bounded by what the owner attached. Five files at
 * 4 MB each, base64-expanded by a third, plus the transcript: 32 MB is
 * generous for that and still refuses a body that would be read into memory,
 * parsed, and written to a row before anyone noticed. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Read the body without trusting Content-Length, which a client sets. */
async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    throw new ChatRequestError('That message is too large. Attach smaller files.', 413);
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES)
    throw new ChatRequestError('That message is too large. Attach smaller files.', 413);
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
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
    parsed = parseChatRequest(await readBody(request));
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
    // Two ways a run can be stopped on a person, and each is released only by
    // its own kind of reply. The rule is in lib/runs/resume so it can be tested
    // without a worker, a database or a session.
    const kind = releases(paused?.status, incomingMessage);
    const release = kind === 'approval' ? store.requeueApproved : store.requeueAnswered;
    if (kind && incomingMessage) {
      // The decision has to land on the stored turn before the run is
      // released. When it does not, the message is not the one this run is
      // paused on, and requeueing anyway would re-drive an unanswered
      // transcript — which reads, from the outside, as the answer being
      // ignored.
      const recorded = store.replaceMessage(conversationId, {
        id: incomingMessage.id,
        parts: incomingMessage.parts,
      });
      if (!recorded)
        return fail('That answer no longer matches the paused turn. Reload the conversation.', 409);
      // False when the run has moved on, which absorbs a duplicate answer
      // rather than starting a second run over the same conversation.
      if (release(already)) void worker.tick();
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

  // The key is resolved once, here, and stored on the run so the worker can
  // drive it after this request has gone. It is never returned to the browser.
  let savedKey = '';
  if (parsed.apiKeySecret) {
    try {
      savedKey = await createSecretStore().resolve(
        user.userId,
        parsed.apiKeySecret,
        providerDestination(parsed.baseUrl),
      );
    } catch {
      savedKey = '';
    }
  }
  // Who is allowed to spend what. The deployment's own key used to be the
  // fallback for anyone signed in, which is invisible with one account and an
  // open bar with two.
  const entitlements = entitlementsForUser(user);
  const access = runAccess({
    entitlements,
    savedKey,
    deploymentKey: process.env.HIKMAH_PROVIDER_KEY ?? '',
  });

  // Refuse now, in words, rather than queueing a run that cannot succeed. A
  // hosted provider without a key answers 401, which reached the owner as a
  // bare "An error occurred" — the commonest first-run failure there is, and
  // the one where knowing the cause is the whole fix. A private or loopback
  // endpoint (Ollama, vLLM) legitimately needs no key, so it is not refused.
  const refused = refusal({
    access,
    entitlements,
    keyless: needsKey(parsed.baseUrl, access.apiKey),
    meteredThisMonth: access.metered ? billingStore().meteredThisMonth(user.userId) : 0,
  });
  if (refused) return fail(refused, 400);

  // Everything above this line only reads. Nothing is written to the transcript
  // until the run is known to be startable, because a refusal after the write
  // leaves a question with no answer — and after the truncate below it would
  // destroy the turn it was replaying. Both were visible on the deployed site
  // as a column of unanswered messages.

  // Answering again replays a message that is already a row, so the turn it
  // started has to go before it can be written back. Without this the insert
  // below hits the messages primary key, the route fails outside any handler,
  // and the owner is told only that the run could not be started.
  //
  // Scoped to the trigger and to this conversation: a plain new turn never
  // deletes anything, and truncateFrom is a no-op for an id it cannot find.
  if (parsed.regenerate && incoming.id) store.truncateFrom(conversationId, incoming.id);

  try {
    store.appendMessage(conversationId, {
      id: incoming.id ?? newMessageId(),
      role: incoming.role,
      parts: incoming.parts,
      metadata: undefined,
    });
  } catch {
    // The only way here is a message id that already exists, which means this
    // turn has already been recorded. Say so rather than returning a 500 with
    // no body for the transport to make sense of.
    return fail('That message was already sent. Reload to see the conversation.', 409);
  }
  // Name it from the message that started it. setTitle only writes when the
  // title is still empty, so a later message cannot rename a conversation the
  // owner has been finding in the list by that name.
  if (incoming.role === 'user') {
    const title = conversationTitle(incoming.parts);
    if (title) store.setTitle(conversationId, title);
  }

  // The co-model's notes on the recent turns, composed here rather than sent by
  // the client: it needs the field checkpoints on disk and whichever one this
  // owner has activated, and a run resumed after the tab closed has no client
  // to ask. Written onto the run row with the rest of the instructions, so a
  // run paused on an approval resumes with the notes it started with.
  const contextNotes = await contextBriefFor(user.userId, messages);

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
        apiKey: access.apiKey,
        metered: access.metered,
        execution: access.execution,
        instructions: parsed.instructions + contextNotes,
        maxSteps: parsed.maxSteps,
        contextCharacters: parsed.contextCharacters,
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

/**
 * The local syntax compiler's block for this turn, or ''.
 *
 * Never throws and never blocks the send: a checkpoint that will not load, a
 * language with no grammar, or a parse that produced nothing worth saying all
 * mean the run goes without notes. The setting is read from the stored row
 * rather than the request, so it is the owner's choice and not the page's.
 */
async function contextBriefFor(userId: string, messages: UIMessage[]): Promise<string> {
  try {
    const storage = getStorage();
    if (!createChatSettingsStore(storage.raw).read(userId).contextModel) return '';
    const active = createActiveCheckpointStore(storage.raw, storage.BUCKET);
    const { block } = await buildContextBrief({
      messages,
      loadField: (language) => loadFieldForUser(userId, language, active),
    });
    return block ? '\n\n' + block : '';
  } catch (error) {
    console.error(
      '[hikmah] context notes skipped:',
      error instanceof Error ? error.message : error,
    );
    return '';
  }
}
