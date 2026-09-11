import {getChatGPTUser} from '../../chatgpt-auth';
import {webToolRequest} from '@/lib/server/web-tools';
import {createSecretStore} from '@/server/workspace-secrets.mjs';
export const dynamic='force-dynamic';
export async function POST(request:Request){const user=await getChatGPTUser();return webToolRequest(request,Boolean(user),()=>createSecretStore().resolve(user!.userId,'BRAVE_SEARCH_API_KEY','search:brave',true));}
