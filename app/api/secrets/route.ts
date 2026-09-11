import {getChatGPTUser} from '../../chatgpt-auth';
import {secretsRequest} from '@/lib/server/secrets-api';
export const dynamic = 'force-dynamic';
async function handle(request: Request) { return secretsRequest(request, (await getChatGPTUser())?.userId); }
export const GET = handle;
export const PUT = handle;
export const DELETE = handle;
