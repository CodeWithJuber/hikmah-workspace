/** What a run is prepared with before it is queued.
 *
 * Shared by the chat turn (`/api/conversations/[id]/runs`) and the background
 * task (`/api/conversations/tasks`), so the two are refused on exactly the
 * same grounds and carry exactly the same aids. Each function here answers one
 * question the route used to answer inline: who may spend what, what the
 * co-model noted, and what the person has saved that bears on this turn.
 */
import type { UIMessage } from 'ai';
import type { ChatRequestBody } from '../ai/chat-request.ts';
import { createSecretStore } from '@/server/workspace-secrets.mjs';
import { needsKey, providerDestination } from '../ai/endpoint.ts';
import { billingStore, entitlementsForUser } from '../billing/server.ts';
import { refusal, runAccess, type RunAccess } from '../billing/access.ts';
import type { Entitlements } from '../billing/entitlements.ts';
import { getStorage } from '@/server/storage.mjs';
import { createChatSettingsStore } from '../chat/settings-store.ts';
import { createActiveCheckpointStore } from '../context-model/active-store.ts';
import { loadFieldForUser } from '../context-model/server.ts';
import { buildContextBrief, recentUserText } from '../context-model/run-brief.ts';
import { candidatesFrom } from '../context-model/candidates.ts';
import { createCandidateStore } from '../context-model/candidate-store.ts';
import { createKnowledgeSources } from '../knowledge/store.ts';
import { knowledgeForRun } from '../knowledge/run-knowledge.ts';
import { createMemoryStore } from '../memory/store.ts';
import { createRecall, recallPrompt } from '../memory/recall.ts';
import type { RecalledConversation, UsedMemory } from './service.ts';
import { createLearningStore } from '../learning/store.ts';
import { reviewedExamplePrompt } from '../learning/retrieval.ts';
import { redactLearningText } from '../learning/privacy.ts';
import { learningSecrets } from '../learning/server.ts';

/**
 * Who may spend what on this run, and why not.
 *
 * The key is resolved once, here, and encrypted on the run so the worker can
 * drive it after the request has gone. It is never returned to the browser.
 * The deployment's own key used to be the fallback for anyone signed in, which
 * is invisible with one account and an open bar with two.
 *
 * `refused` is set when the run cannot succeed and should not be queued: a
 * hosted provider without a key answers 401, which reached the owner as a bare
 * "An error occurred" — the commonest first-run failure there is, and the one
 * where knowing the cause is the whole fix. A private or loopback endpoint
 * (Ollama, vLLM) legitimately needs no key, so it is not refused.
 */
export async function resolveRunAccess(
  user: { userId: string; email: string },
  parsed: Pick<ChatRequestBody, 'apiKeySecret' | 'baseUrl'>,
): Promise<{ access: RunAccess & { entitlements: Entitlements }; refused: string | null }> {
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
  const entitlements = entitlementsForUser(user);
  const access = runAccess({
    entitlements,
    savedKey,
    deploymentKey: process.env.HIKMAH_PROVIDER_KEY ?? '',
  });
  const refused = refusal({
    access,
    entitlements,
    keyless: needsKey(parsed.baseUrl, access.apiKey),
    meteredThisMonth: access.metered ? billingStore().meteredThisMonth(user.userId) : 0,
  });
  return { access: { ...access, entitlements }, refused };
}

/**
 * The local syntax compiler's block for this turn, or ''.
 *
 * Never throws and never blocks the send: a checkpoint that will not load, a
 * language with no grammar, or a parse that produced nothing worth saying all
 * mean the run goes without notes. The setting is read from the stored row
 * rather than the request, so it is the owner's choice and not the page's.
 */
export async function contextBriefFor(userId: string, messages: UIMessage[]): Promise<string> {
  try {
    const storage = getStorage();
    if (!createChatSettingsStore(storage.raw).read(userId).contextModel) return '';
    const active = createActiveCheckpointStore(storage.raw, storage.BUCKET);
    const { block, graph } = await buildContextBrief({
      messages,
      loadField: (language) => loadFieldForUser(userId, language, active),
    });
    // The turn has just been parsed to build the block above, and the parse
    // measured how sure it was of each sentence. That measurement is the only
    // thing a chat can honestly give a parser fitted on gold annotations — the
    // reply itself carries no grammar to learn from — so the hardest sentences
    // are kept for the owner to correct rather than discarded with the parse.
    // Inside this try, and after the block is computed, so a queue that cannot
    // be written costs the queue and never the notes or the message.
    try {
      const learning = createLearningStore(storage.raw);
      const consent = learning.policy(userId);
      if (graph && consent.collectSyntax) {
        // Collection is a separate opt-in from using context notes. Only the
        // latest user turn is eligible: enabling this cannot backfill history.
        const currentText = recentUserText(messages, 1);
        const secrets = await learningSecrets(userId);
        const candidates = candidatesFrom(graph).filter(
          (candidate) =>
            currentText.includes(candidate.text) &&
            redactLearningText(candidate.text, secrets).redactions.length === 0,
        );
        // Annotation and surface text must agree, so sensitive sentences are
        // skipped rather than replacing words without rebuilding their grammar.
        const still = learning.policy(userId);
        if (still.collectSyntax && still.revision === consent.revision)
          createCandidateStore(storage.raw).record(userId, candidates);
      }
    } catch {
      // Failed collection must not discard the already-computed context notes.
    }
    return block ? '\n\n' + block : '';
  } catch (error) {
    console.error(
      '[hikmah] context notes skipped:',
      error instanceof Error ? error.message : error,
    );
    return '';
  }
}

/**
 * The owner's saved knowledge for this turn, or ''.
 *
 * Read here rather than sent by the page for the same reason the context notes
 * are: it needs the workspace blob and the published rows, and a run resumed
 * after the tab closed has no page to ask. Never throws — a lookup that fails
 * costs the aid, not the answer.
 */
export async function knowledgeFor(
  userId: string,
  messages: UIMessage[],
  options: { conversationId: string; recall: boolean },
): Promise<{
  block: string;
  recall: string;
  used: UsedMemory[];
  conversations: RecalledConversation[];
}> {
  const none = { block: '', recall: '', used: [], conversations: [] };
  try {
    const storage = getStorage();
    const query = recentUserText(messages, 1);
    if (!query.trim()) return none;
    let used: UsedMemory[] = [];
    const block = await knowledgeForRun({
      sources: createKnowledgeSources(storage.raw, storage.BUCKET),
      userId,
      query,
      onSelected: (items) => {
        used = items.map((item) => ({ id: item.id, title: item.title, kind: item.kind }));
      },
    });
    if (used.length) {
      // Best effort: a count that did not move is not worth a failed answer.
      createMemoryStore(storage.raw).markUsed(
        userId,
        used.map((item) => item.id),
      );
    }
    // Earlier conversations that share words with the question — never this
    // one, which the run already has in full. Off by a switch, because it
    // costs a little of the prompt on every turn.
    const hits = options.recall
      ? createRecall(storage.raw).recall(userId, query, options.conversationId)
      : [];
    let learned = '';
    try {
      learned = reviewedExamplePrompt(query, createLearningStore(storage.raw).approved(userId));
    } catch {
      /* A missing learning aid must not discard saved memories. */
    }
    return {
      block: [block, learned].filter(Boolean).join('\n\n'),
      recall: recallPrompt(hits),
      used,
      conversations: hits.map((hit) => ({ id: hit.conversationId, title: hit.title })),
    };
  } catch (error) {
    console.error('[hikmah] knowledge skipped:', error instanceof Error ? error.message : error);
    return none;
  }
}
