import { getChatGPTUser } from '../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { getStorage } from '@/server/storage.mjs';
import { createLearningStore, LearningError } from '@/lib/learning/store';
import { learningSecrets } from '@/lib/learning/server';
import type { ExampleStatus, LearningPolicy } from '@/lib/learning/types';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });
const store = () => createLearningStore(getStorage().raw);
const statuses = new Set(['pending', 'approved', 'rejected']);

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  const site = request.headers.get('sec-fetch-site');
  if (site && !['same-origin', 'none'].includes(site))
    return fail('Use this from your signed-in workspace.', 403);
  try {
    const params = new URL(request.url).searchParams;
    const exporting = params.get('export');
    if (exporting) {
      if (exporting !== 'all' && exporting !== 'approved')
        return fail('Choose approved or all examples to export.', 400);
      return new Response(store().export(user.userId, exporting), {
        headers: {
          ...headers,
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': 'attachment; filename="hikmah-learning-examples.jsonl"',
        },
      });
    }
    const status = params.get('status');
    if (status && !statuses.has(status)) return fail('Choose a valid review status.', 400);
    const offset = Number(params.get('offset') ?? 0),
      limit = Number(params.get('limit') ?? 50);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      return fail('Choose a valid page and a limit from 1 to 100.', 400);
    return Response.json(
      store().snapshot(user.userId, {
        status: status ? (status as ExampleStatus) : undefined,
        offset,
        limit,
      }),
      { headers },
    );
  } catch {
    return fail('Learning storage is unavailable. Try again.', 503);
  }
}

/** Bounded streaming read: Content-Length is supplied by the client. */
async function readBody(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new LearningError('Send a JSON request body.');
  const reader = request.body?.getReader();
  if (!reader) throw new LearningError('Send a JSON request body.');
  let bytes = 0,
    text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 128_000) throw new LearningError('Use a smaller learning update.', 413);
      text += decoder.decode(value, { stream: true });
    }
    let body: unknown;
    try {
      body = JSON.parse(text + decoder.decode());
    } catch {
      throw new LearningError('Send a valid JSON request body.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new LearningError('Send a learning action.');
    return body as Record<string, unknown>;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);
  try {
    const body = await readBody(request),
      learning = store();
    let example;
    if (body.action === 'configure') {
      const patch: Partial<Omit<LearningPolicy, 'revision'>> = {};
      for (const key of ['enabled', 'useApproved', 'collectSyntax', 'retentionDays'] as const)
        if (body[key] !== undefined) Object.assign(patch, { [key]: body[key] });
      learning.configure(user.userId, patch);
    } else if (body.action === 'review') {
      if (
        typeof body.id !== 'string' ||
        body.id.length > 80 ||
        typeof body.revision !== 'number' ||
        !statuses.has(body.status as string)
      )
        throw new LearningError('Choose an example, its current revision and a review status.');
      if (
        body.correction !== undefined &&
        body.correction !== null &&
        typeof body.correction !== 'string'
      )
        throw new LearningError('The correction must be text or null.');
      example = learning.review(
        user.userId,
        {
          id: body.id,
          revision: body.revision,
          status: body.status as ExampleStatus,
          correction: body.correction as string | null | undefined,
        },
        typeof body.correction === 'string' ? await learningSecrets(user.userId) : [],
      );
    } else if (body.action === 'delete') {
      if (typeof body.id !== 'string' || body.id.length > 80)
        throw new LearningError('Choose an example to delete.');
      if (!learning.remove(user.userId, body.id))
        throw new LearningError('That example was not found.', 404);
    } else if (body.action === 'clear') learning.clear(user.userId);
    else throw new LearningError('Choose a valid learning action.');
    return Response.json(
      { ...learning.snapshot(user.userId), ...(example ? { example } : {}) },
      { headers },
    );
  } catch (error) {
    return error instanceof LearningError
      ? fail(error.message, error.status)
      : fail('The learning update could not be saved. Try again.', 503);
  }
}
