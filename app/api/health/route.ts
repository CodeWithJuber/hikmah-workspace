import { APP_RELEASE, BUILD_ID } from '@/lib/release';
import { getStorage } from '@/server/storage.mjs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    getStorage().raw.prepare('SELECT 1').get();
    // Reported, never fatal: a stalled worker is worth seeing, but it must not
    // take the container out of rotation while the app still serves chat.
    let worker: { started: boolean; queued: number } | undefined;
    try {
      const { runService } = await import('@/lib/runs/service');
      const service = runService();
      worker = {
        started: service.started,
        queued: service.store.countQueued(),
      };
    } catch {
      worker = undefined;
    }
    return Response.json(
      { status: 'ok', release: APP_RELEASE, revision: BUILD_ID, worker },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { status: 'unavailable', release: APP_RELEASE, revision: BUILD_ID },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
