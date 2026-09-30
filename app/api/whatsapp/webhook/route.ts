import { webhookRequest } from '@/lib/whatsapp/api';
import { whatsappContext } from '@/lib/whatsapp/app-context';

export const dynamic = 'force-dynamic';

/**
 * Meta's webhook. GET is the verification handshake (authenticated by the
 * verify token); POST is the signed event stream (authenticated by the HMAC
 * signature, routed to the owning account by phone_number_id). No owner
 * session — Meta's servers call this, not a browser.
 */
export async function GET(request: Request) {
  return webhookRequest(request, whatsappContext(request, null));
}

export async function POST(request: Request) {
  return webhookRequest(request, whatsappContext(request, null));
}
