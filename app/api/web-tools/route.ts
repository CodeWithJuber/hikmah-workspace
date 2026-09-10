import {getChatGPTUser} from '../../chatgpt-auth';
import {webToolRequest} from '@/lib/server/web-tools';
export const dynamic='force-dynamic';
export async function POST(request:Request){return webToolRequest(request,Boolean(await getChatGPTUser()));}
