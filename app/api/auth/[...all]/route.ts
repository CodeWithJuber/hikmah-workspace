import { getAuth } from '@/server/auth.mjs';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
async function handle(request: Request) { return (await getAuth()).handler(request); }
export const GET = handle;
export const POST = handle;
