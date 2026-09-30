import { randomUUID } from 'node:crypto';
import { ownerIdentity, sameOrigin, failure, KernelHttpError } from '@/lib/kernel/server';
import { getStorage } from '@/server/storage.mjs';
import { createLearningStore } from '@/lib/learning/store';
import {
  createReleaseStore,
  planDatasetVersion,
  splitHoldout,
  verifyHoldoutDisjoint,
  assertReleaseConsent,
  LearningReleaseError,
  type DatasetItem,
} from '@/lib/learning/releases';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });
const store = () => createReleaseStore(getStorage().raw);
const learningStore = () => createLearningStore(getStorage().raw);

/** Bounded JSON body read, following app/api/learning/route.ts. */
async function readBody(request: Request, maxBytes = 512_000) {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new LearningReleaseError('bad-body', 'Send a JSON request body.', 400);
  const reader = request.body?.getReader();
  if (!reader) throw new LearningReleaseError('bad-body', 'Send a JSON request body.', 400);
  let bytes = 0,
    text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes)
        throw new LearningReleaseError('too-large', 'Use a smaller release proposal.', 413);
      text += decoder.decode(value, { stream: true });
    }
    const body = JSON.parse(text + decoder.decode());
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new LearningReleaseError('bad-body', 'Send a release proposal.', 400);
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof LearningReleaseError) throw error;
    throw new LearningReleaseError('bad-body', 'Send a valid JSON request body.', 400);
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export async function GET() {
  try {
    await ownerIdentity();
    const releases = store();
    return Response.json(
      { releases: releases.listReleases(), active: releases.activeRelease() ?? null },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}

/** Propose a release: version the dataset, gate on consent, split the
 * independent holdout, and record the release as proposed. */
export async function POST(request: Request) {
  try {
    const user = await ownerIdentity();
    sameOrigin(request);
    const body = await readBody(request);
    if (body.action !== 'propose') return fail('Choose a valid release action.', 400);
    const dataset = body.dataset;
    if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset))
      return fail('Propose a dataset with language, source and items.', 400);
    const d = dataset as Record<string, unknown>;
    const items = Array.isArray(d.items) ? d.items : [];
    if (!items.length || items.length > 2000)
      return fail('Propose between 1 and 2,000 dataset items.', 400);
    const parsed: DatasetItem[] = [];
    for (const item of items) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof (item as { fingerprint?: unknown }).fingerprint !== 'string' ||
        !(item as { fingerprint: string }).fingerprint.trim() ||
        (item as { fingerprint: string }).fingerprint.length > 128
      )
        return fail('Every dataset item needs a fingerprint.', 400);
      parsed.push({ fingerprint: (item as { fingerprint: string }).fingerprint.trim() });
    }
    for (const key of ['language', 'source', 'consentScope'] as const)
      if (typeof d[key] !== 'string' || !(d[key] as string).trim())
        return fail(`Propose a dataset ${key}.`, 400);
    if (d.version !== undefined && (typeof d.version !== 'string' || !d.version.trim()))
      return fail('Propose a valid dataset version or none.', 400);
    const seed =
      typeof body.splitSeed === 'string' && body.splitSeed.trim()
        ? body.splitSeed.trim()
        : randomUUID();
    if (seed.length > 128) return fail('Use a shorter holdout seed.', 400);

    const policy = learningStore().policy(user.userId);
    const releases = store();
    const known = new Map(releases.listDatasets().map((row) => [row.version, row.hash] as const));
    const plan = planDatasetVersion({
      items: parsed,
      claimedVersion: typeof d.version === 'string' ? d.version.trim() : undefined,
      known,
    });
    const existing = releases.datasetByVersion(plan.version);
    // JEV hard-refuse: the CURRENT consent policy must cover the dataset.
    assertReleaseConsent({
      policy: { enabled: policy.enabled, revision: policy.revision },
      consentRevision: existing ? existing.consent_revision : policy.revision,
    });
    if (!plan.reused)
      releases.recordDataset({
        version: plan.version,
        language: (d.language as string).trim().toLowerCase(),
        source: (d.source as string).trim(),
        consentScope: (d.consentScope as string).trim(),
        consentRevision: policy.revision,
        hash: plan.hash,
        itemCount: parsed.length,
      });
    const split = splitHoldout(parsed, { seed });
    verifyHoldoutDisjoint(split.train, split.holdout);
    const holdoutId = releases.recordHoldout({
      datasetVersion: plan.version,
      splitSeed: seed,
      items: split.holdout.map((item) => item.fingerprint),
    });
    const previous = releases.activeRelease();
    const releaseId = releases.createRelease({
      datasetVersion: plan.version,
      previousReleaseId: previous?.id ?? null,
      createdBy: user.userId,
    });
    return Response.json(
      {
        release: releases.release(releaseId),
        dataset: { version: plan.version, hash: plan.hash, reused: plan.reused },
        holdout: {
          id: holdoutId,
          seed,
          trainCount: split.train.length,
          holdoutCount: split.holdout.length,
        },
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof LearningReleaseError) return fail(error.message, error.status);
    if (error instanceof KernelHttpError) return failure(error);
    return fail('The release proposal could not be recorded. Try again.', 503);
  }
}
