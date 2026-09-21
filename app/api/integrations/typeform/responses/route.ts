import { getChatGPTUser } from '@/app/chatgpt-auth';
import { typeformRequest } from '@/lib/integrations/typeform-api';
import { typeformService } from '@/lib/integrations/typeform-server';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return typeformRequest(request, (await getChatGPTUser())?.userId, typeformService(), 'responses');
}
