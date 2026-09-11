import {ownerIdentity} from '@/lib/kernel/server';
import {runtimeRelay} from '@/lib/server/runtime-relay';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  let owner = false;
  try { await ownerIdentity(); owner = true; } catch { /* No runtime authority. */ }
  return runtimeRelay(request, owner);
}
export async function GET() {
  try {
    await ownerIdentity();
    return Response.json({configured: Boolean(process.env.HIKMAH_RUNTIME_URL && process.env.HIKMAH_RUNTIME_TOKEN)}, {headers: {'Cache-Control': 'no-store, private'}});
  } catch { return Response.json({configured: false}, {headers: {'Cache-Control': 'no-store, private'}}); }
}
