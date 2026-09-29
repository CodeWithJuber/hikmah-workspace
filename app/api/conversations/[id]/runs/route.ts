import { validateUIMessages, type UIMessage } from 'ai';
import { getChatGPTUser } from '../../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { ChatRequestError, assertSameOrigin, parseChatRequest } from '@/lib/ai/chat-request';
import { conversationTitle } from '@/lib/chat/title';
import { releases } from '@/lib/runs/resume';
import { newMessageId, newRunId, runService } from '@/lib/runs/service';
import { enqueueRun, enqueueCap, EnqueueFullError } from '@/lib/runs/enqueue';
import { createWorkflowStore } from '@/lib/workflow/store';
import { answerIdFor } from '@/lib/runs/answer-id';
import { contextBriefFor, knowledgeFor, resolveRunAccess } from '@/lib/runs/prepare';
import { getStorage } from '@/server/storage.mjs';
import { createChatSettingsStore } from '@/lib/chat/settings-store';
import { composePrompt } from '@/lib/ai/compose-prompt';
import { principleDigest } from '@/lib/kernel/principles';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

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

/** The latest user turn's text, for the arm-selection policy's features. */
function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = (message.parts ?? [])
      .filter((part) => part?.type === 'text')
      .map((part) => (part as { text?: string }).text ?? '')
      .join('\n')
      .trim();
    if (text) return text.slice(0, 4000);
  }
  return '';
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
      // By the id the browser has, or failing that by the id the worker
      // stores the answer under: a tab opened before the stream began naming
      // the message still holds an id of its own making.
      const recorded =
        store.replaceMessage(conversationId, {
          id: incomingMessage.id,
          parts: incomingMessage.parts,
        }) ||
        store.replaceMessage(conversationId, {
          id: answerIdFor(already),
          parts: incomingMessage.parts,
        });
      if (!recorded)
        return fail('That answer no longer matches the paused turn. Reload the conversation.', 409);
      // False when the run has moved on, which absorbs a duplicate answer
      // rather than starting a second run over the same conversation.
      if (release(already)) void worker.tick();
      return Response.json({ runId: already, conversationId, resumed: true }, { headers });
    }
    // The status matters to the client, not just the fact of a run.
    //
    // A run that is queued or streaming will answer this conversation shortly,
    // and tailing it is the honest response to a double submit. A run *paused
    // on a person* will not: it is waiting for an approval or an answer above,
    // and a new message is neither. Told apart here, the browser can say so
    // instead of attaching to a stream that will never produce another token —
    // which is how three questions in a row got no reply and no error.
    return Response.json(
      { runId: already, conversationId, alreadyRunning: true, status: paused?.status ?? null },
      { headers, status: 409 },
    );
  }
  if (store.countActive(user.userId) >= enqueueCap())
    return fail('Too many runs are already in progress. Wait for one to finish.', 429);

  const incoming = incomingMessage;
  if (!incoming) return fail('Send a message to start the run.', 400);

  // Who may spend what, decided in lib/runs/prepare.ts so a background task
  // is refused on exactly the same grounds as a chat turn.
  const { access, refused } = await resolveRunAccess(user, parsed);
  if (refused) return fail(refused, 400);
  const entitlements = access.entitlements;

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
  //
  // Branching (Chat v2): the replayed message keeps its place in the tree.
  // Its parent is read before the truncate, so the re-appended row lands
  // under the same parent — an edited question becomes a sibling of the one
  // it replaces, not a new root or a misplaced child. A plain new turn
  // answers whatever the active path ends at.
  const turnParentId =
    parsed.regenerate && incoming.id
      ? store.getMessageParent(conversationId, incoming.id)
      : store.lastActiveMessageId(conversationId);
  if (parsed.regenerate && incoming.id) store.truncateFrom(conversationId, incoming.id);

  // The id the user message is stored under: the run's answer is its child
  // in the tree, which is what makes a regenerated answer a sibling of the
  // preserved one rather than a stranger. Computed once so the row and the
  // run config below can never disagree.
  const userMessageId = incoming.id ?? newMessageId();

  try {
    store.appendMessage(
      conversationId,
      {
        id: userMessageId,
        role: incoming.role,
        parts: incoming.parts,
        metadata: undefined,
      },
      turnParentId,
    );
  } catch {
    // The only way here is a message id that already exists, which means this
    // turn has already been recorded. Say so rather than returning a 500 with
    // no body for the transport to make sense of.
    return fail('That message was already sent. Reload to see the conversation.', 409);
  }
  // Name it from the message that started it. setTitle only writes when the
  // title is still empty, so a later message cannot rename a conversation the
  // owner has been finding in the list by that name. uniqueTitle keeps two
  // conversations that open the same way from sharing one sidebar row.
  if (incoming.role === 'user') {
    const title = conversationTitle(incoming.parts);
    if (title)
      store.setTitle(conversationId, store.uniqueTitle(user.userId, title, conversationId));
  }

  // The two aids are independent — the brief never reads the knowledge rows
  // and the knowledge lookup never reads the brief — so they are fetched
  // together: sequential awaits made every run pay the sum of both lookups
  // before it could be queued. Both functions are noexcept by construction
  // (they catch and log internally), so Promise.all preserves the old error
  // semantics exactly.
  const chatSettings = createChatSettingsStore(getStorage().raw).read(user.userId);
  const [contextNotes, saved] = await Promise.all([
    // The co-model's notes on the recent turns, composed here rather than sent by
    // the client: it needs the field checkpoints on disk and whichever one this
    // owner has activated, and a run resumed after the tab closed has no client
    // to ask. Written onto the run row with the rest of the instructions, so a
    // run paused on an approval resumes with the notes it started with.
    contextBriefFor(user.userId, messages),
    // What this person has saved, and what the operator has published. Both were
    // written, tested and then called by nothing after the browser run loop was
    // deleted — the Memory screen has been saving items no answer could read.
    //
    // Incognito: the session opts out entirely, server-side, not just in the
    // UI. Skipping the lookup here is what makes the toggle honest — no block,
    // no recall, no used-count marks — rather than a client-side promise the
    // server quietly breaks.
    parsed.incognito
      ? Promise.resolve({ block: '', recall: '', used: [], conversations: [] })
      : knowledgeFor(user.userId, messages, {
          conversationId,
          recall: chatSettings.memory.recallConversations,
        }),
  ]);

  const runId = newRunId();
  try {
    enqueueRun({
      runId,
      userId: user.userId,
      conversationId,
      priority: entitlements.queuePriority,
      // The policy's view of this turn: what was asked, in which category,
      // and whether a remote arm is even allowed. The policy never overrides
      // eligibility — no key means no remote arms, whatever it scores.
      selection: {
        promptText: lastUserText(messages),
        taskCategory: 'chat',
        hasProviderKey: access.apiKey !== '',
        localFrame: null,
      },
      store,
      workflowStore: createWorkflowStore(getStorage().raw),
      config: {
        baseUrl: parsed.baseUrl,
        model: parsed.model,
        freeOnly: parsed.freeOnly,
        // The tree parent for the run's answer (Chat v2 message branching):
        // the user message this turn was stored under, so the answer lands
        // as its child and a regenerated answer becomes a sibling of the
        // preserved one.
        replyParentId: userMessageId,
        apiKey: access.apiKey,
        metered: access.metered,
        execution: access.execution,
        // Both decided at creation and stored on the run, like execution: a
        // plan that changes while a run is queued or paused must not widen or
        // narrow work already in flight.
        media: entitlements.media,
        operator: entitlements.tier === 'owner',
        // Named parts in one stated order, rather than whichever order the
        // features were added in. See lib/ai/compose-prompt.ts.
        instructions: composePrompt({
          base: parsed.instructions,
          principles: principleDigest(),
          knowledge: saved.block,
          recall: saved.recall,
          contextNotes,
        }),
        // What the answer drew on, so the run can say so where the person is
        // reading. The ids are counted as used at creation, not when the
        // answer lands: a run resumed after a restart still used them.
        memories: saved.used,
        recalled: saved.conversations,
        // Whether `remember` may save a verbatim preference without review.
        // Decided here like every other policy on the run, so a switch flipped
        // while a run is paused does not change what it was allowed to do.
        // Incognito also withholds the tool itself (see service.ts): without
        // review it could still file suggestions.
        remember: { autoSave: parsed.incognito ? false : chatSettings.memory.autoSaveQuotes },
        // Incognito narrows the server-owned learning consent to disabled.
        // createRun honours an explicit disable but never an enable, so a
        // caller can opt a run out of capture but never opt one in.
        learning: parsed.incognito ? { enabled: false, revision: -1 } : undefined,
        incognito: parsed.incognito,
        maxSteps: parsed.maxSteps,
        contextCharacters: parsed.contextCharacters,
        contextWindow: parsed.contextWindow,
        disabledTools: parsed.disabledTools,
        enabledTools: parsed.enabledTools,
        compare: parsed.compare,
        deepResearch: parsed.deepResearch,
        webSearch: parsed.webSearch,
      },
    });
  } catch (error) {
    // enqueueRun re-checks the cap at queue time, so a burst that filled the
    // last slot between the pre-check above and here still gets a 429 rather
    // than a silently queued run nobody will drive soon.
    if (error instanceof EnqueueFullError)
      return fail('Too many runs are already in progress. Wait for one to finish.', 429);
    return fail('The run could not be queued. Try again.', 503);
  }

  // Nudge the loop rather than waiting for the next poll, so the first token
  // arrives as quickly as it did when the browser drove the run.
  void worker.tick();

  return Response.json({ runId, conversationId }, { headers, status: 202 });
}
