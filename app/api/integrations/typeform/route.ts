import { getChatGPTUser } from '@/app/chatgpt-auth';
import { typeformRequest } from '@/lib/integrations/typeform-api';
import { typeformService } from '@/lib/integrations/typeform-server';
export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  return typeformRequest(request, (await getChatGPTUser())?.userId, typeformService());
}
export const GET = handle;
export const PUT = handle;
export const POST = handle;
export const DELETE = handle;
