import { getChatGPTUser } from '../../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { runService } from '@/lib/runs/service';

export const dynamic = 'force-dynamic';

/**
 * Stop a run.
 *
 * A client disconnecting does not stop generation: the run belongs to the
 * server now, which is the whole point of moving it there. Stopping is
 * therefore an explicit request, and it aborts the provider call rather than
 * only closing a stream.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401 });
  if (request.headers.get('origin') !== publicOrigin(request))
    return Response.json({ error: 'Use this from your signed-in workspace.' }, { status: 403 });

  const { id } = await context.params;
  const worker = runService();
  const run = worker.store.getRun(id);
  if (!run || run.user_id !== user.userId)
    return Response.json({ error: 'Run not found.' }, { status: 404 });

  const stopped = worker.cancel(id);
  return Response.json({ stopped, status: worker.store.getRun(id)?.status ?? run.status });
}
