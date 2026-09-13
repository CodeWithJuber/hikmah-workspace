/** Loading the co-model's field checkpoints on the server.
 *
 * `client.ts` fetches them over HTTP from the browser, which is why the whole
 * feature died with the browser run loop: a relative fetch has no meaning in
 * the worker, and a durable run has no tab to ask. The server has the files —
 * `public/research/v6/models/<lang>.model.json` ships in the image and
 * `scripts/start.mjs` puts it beside `server.js` in the standalone build — so
 * it reads them directly.
 *
 * Nothing here imports Next, so it can be exercised against real checkpoints
 * without a server.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateField, type FieldModel } from './field-model.ts';

/** The languages a checkpoint was trained for. Anything else is left to the
 * text itself rather than parsed by the wrong grammar. */
export const SUPPORTED_LANGUAGES = ['en', 'ar', 'hi', 'es', 'tr'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const isSupported = (language: string): language is SupportedLanguage =>
  (SUPPORTED_LANGUAGES as readonly string[]).includes(language);

/**
 * How many parsed checkpoints stay resident.
 *
 * Measured: a released model is 0.9–1.5 MB on disk and roughly 13 MB once
 * parsed, and all five together took a process from 60 MB to 126 MB. The app
 * container is budgeted 1 GiB, so five resident grammars is a real fraction of
 * it for a feature that is one line of a system prompt. Two covers a bilingual
 * conversation, which is the case that actually occurs.
 */
const MAX_RESIDENT = 2;

/** Insertion-ordered, so the oldest key is the first the iterator yields. */
const resident = new Map<string, FieldModel>();
/** In-flight loads, so two runs starting together read the file once. */
const loading = new Map<string, Promise<FieldModel>>();

function remember(key: string, model: FieldModel): FieldModel {
  resident.delete(key);
  resident.set(key, model);
  while (resident.size > MAX_RESIDENT) {
    const oldest = resident.keys().next().value;
    if (oldest === undefined) break;
    resident.delete(oldest);
  }
  return model;
}

/** Where the released checkpoints live.
 *
 * `process.cwd()` is the standalone root under `next start` and the repo root
 * in development, and `public/` sits at both. The override exists for a
 * deployment that mounts the research directory elsewhere. */
export function researchDirectory(): string {
  return process.env.HIKMAH_RESEARCH_DIR || join(process.cwd(), 'public', 'research');
}

/** The published checkpoint for a language, read from disk and validated. */
export async function loadReleasedField(language: string): Promise<FieldModel> {
  if (!isSupported(language)) throw Error('No trained syntax checkpoint for ' + language);
  const key = 'released:' + language;
  const already = resident.get(key);
  if (already) return remember(key, already);
  const pending =
    loading.get(key) ??
    readFile(join(researchDirectory(), 'v6', 'models', language + '.model.json'), 'utf8')
      .then((text) => remember(key, validateField(JSON.parse(text))))
      .finally(() => loading.delete(key));
  loading.set(key, pending);
  return pending;
}

/** What the owner has trained and activated, if anything. */
export type ActiveCheckpoint = {
  /** Reads the active version id for this owner and language, or null. */
  activeVersion(userId: string, language: string): string | null;
  /** Reads the stored checkpoint document for a version id. */
  read(userId: string, versionId: string): Promise<unknown>;
};

/**
 * The field model a run should parse with.
 *
 * The owner's activated checkpoint when there is one, the released model
 * otherwise — and the released model again if the activated one cannot be read
 * or does not validate. Training a checkpoint and activating it is supposed to
 * change what runs see; before this it changed nothing at all, because nothing
 * on the server ever loaded one.
 */
export async function loadFieldForUser(
  userId: string,
  language: string,
  active?: ActiveCheckpoint,
): Promise<FieldModel> {
  if (!isSupported(language)) throw Error('No trained syntax checkpoint for ' + language);
  const versionId = active ? safeActiveVersion(active, userId, language) : null;
  if (!versionId) return loadReleasedField(language);

  // Keyed by version rather than by owner: a checkpoint is immutable once
  // saved, so the same id is always the same bytes, and activating a different
  // one is a different key rather than a stale entry.
  const key = 'version:' + versionId;
  const already = resident.get(key);
  if (already) return remember(key, already);
  const pending =
    loading.get(key) ??
    active!
      .read(userId, versionId)
      .then((document) => {
        const model = (document as { model?: unknown } | null)?.model;
        if (!model) throw Error('Checkpoint document has no model.');
        return remember(key, validateField(model));
      })
      .finally(() => loading.delete(key));
  loading.set(key, pending);
  // A checkpoint that will not load is the owner's problem to see on the studio
  // screen, not a reason for their chat to lose the feature entirely.
  return pending.catch(() => loadReleasedField(language));
}

function safeActiveVersion(
  active: ActiveCheckpoint,
  userId: string,
  language: string,
): string | null {
  try {
    return active.activeVersion(userId, language);
  } catch {
    return null;
  }
}

/** Drop everything resident. For tests, and for a checkpoint activated in the
 * same process that is about to be read. */
export function clearFieldCache(): void {
  resident.clear();
  loading.clear();
}
