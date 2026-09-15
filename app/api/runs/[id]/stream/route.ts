import { getChatGPTUser } from '../../../../chatgpt-auth';
import { SSE_HEADERS, resumeCursor, runEventStream } from '@/lib/runs/sse';
import { runService } from '@/lib/runs/service';
import { nothingToSend } from '@/lib/runs/resume';

export const dynamic = 'force-dynamic';

/**
 * Tail a run's output, resuming from the client's cursor.
 *
 * Authenticated by session cookie plus a Sec-Fetch-Site check rather than an
 * Origin comparison: browsers omit Origin on same-origin GETs and on
 * EventSource entirely, so requiring it here would reject every legitimate
 * reconnect.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401 });

  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none')
    return Response.json({ error: 'Use this from your signed-in workspace.' }, { status: 403 });

  const { id } = await context.params;
  const worker = runService();
  const run = worker.store.getRun(id);
  if (!run || run.user_id !== user.userId)
    return Response.json({ error: 'Run not found.' }, { status: 404 });

  const after = resumeCursor(request);
  // Nothing left to send and nothing that will send more without someone
  // acting: 204 tells the client to load the persisted conversation instead of
  // holding a stream open. A run paused on a person counts — see
  // streamIsFinished for what went wrong when it did not.
  if (
    nothingToSend(
      run,
      worker.store.countEventsAfter(id, after),
      worker.store.isTerminal(run.status),
      after,
    )
  )
    return new Response(null, { status: 204 });

  return new Response(
    runEventStream({
      runId: id,
      after,
      store: worker.store,
      bus: worker.bus,
      signal: request.signal,
    }),
    { headers: SSE_HEADERS },
  );
}
