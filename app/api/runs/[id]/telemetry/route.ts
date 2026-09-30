import { getChatGPTUser } from '../../../../chatgpt-auth';
import { runService } from '@/lib/runs/service';
import { getStorage } from '@/server/storage.mjs';
import { assertCanRead, TeamAccessDenied } from '@/lib/team/enforcement';
import { teamStore } from '@/lib/team/server';

export const dynamic = 'force-dynamic';

/**
 * The run's telemetry: its timed segments and its machine-readable outcome.
 *
 * Given a run id, this reconstructs the whole run from submit to accepted
 * result: the ordered segment sequence (queue wait, preparation, MCP
 * handshake, Jev decision, first provider byte, useful output), each timed in
 * milliseconds, plus the reason code of the latest outcome or transition.
 *
 * Authenticated by session cookie plus a Sec-Fetch-Site check, like the run
 * stream route: browsers omit Origin on same-origin GETs and on EventSource
 * entirely, so requiring it here would reject legitimate reads.
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
  if (!run) return Response.json({ error: 'Run not found.' }, { status: 404 });
  // Telemetry is a read of someone's run: owner or team reader, else 404.
  try {
    assertCanRead(getStorage().raw, teamStore(), user.userId, 'run', id);
  } catch (error) {
    if (error instanceof TeamAccessDenied)
      return Response.json({ error: 'Run not found.' }, { status: 404 });
    throw error;
  }

  // Segments and durations only — never prompt text, tool arguments or keys.
  return Response.json({
    runId: run.id,
    status: run.status,
    reasonCode: run.reason_code,
    createdAt: run.created_at,
    endedAt: run.ended_at,
    segments: worker.store.runTimeline(id),
  });
}
