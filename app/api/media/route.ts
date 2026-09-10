import {getChatGPTUser} from '../../chatgpt-auth';
import {relayMediaRequest} from '@/lib/server/media-relay';
export const dynamic='force-dynamic';
async function handle(request:Request){return relayMediaRequest(request,Boolean(await getChatGPTUser()));}
export const GET=handle;
export const POST=handle;
