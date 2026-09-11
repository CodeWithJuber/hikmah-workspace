import { APP_RELEASE, BUILD_ID } from '@/lib/release';
import { getStorage } from '@/server/storage.mjs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    getStorage().raw.prepare('SELECT 1').get();
    return Response.json(
      { status: 'ok', release: APP_RELEASE, revision: BUILD_ID },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { status: 'unavailable', release: APP_RELEASE, revision: BUILD_ID },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
