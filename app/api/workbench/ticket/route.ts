import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { WorkbenchError, issueTicket, terminalUrl, workbenchToken } from '@/lib/workbench/ticket';
import { workbenchUserKey } from '@/lib/workbench/user-key';
import { entitlementsForUser } from '@/lib/billing/server';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

/**
 * Hand the browser a ticket for one terminal connection.
 *
 * POST rather than GET so the Origin header is always present: this is the
 * point where a signed-in session is converted into a shell, and a cross-site
 * page must not be able to make that conversion with the owner's cookies.
 */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401, headers });
  if (request.headers.get('origin') !== publicOrigin(request))
    return Response.json(
      { error: 'Open the terminal from your signed-in workspace.' },
      { status: 403, headers },
    );

  // Each account now has its own Unix user and its own directory in the
  // workbench (workbench/src/slots.ts), so a terminal is no longer a shell in
  // everybody's workspace. Opening it beyond the operator is still a separate
  // product decision and not one a security change gets to make on its own, so
  // the gate stays where it was — the same rule the run tools follow.
  if (!entitlementsForUser(user).execution)
    return Response.json(
      { error: 'The terminal is available to the workspace operator only.' },
      { status: 403, headers },
    );

  try {
    const token = workbenchToken();
    // Named, not anonymous: the workbench gives each account its own Unix user
    // and directory, and a ticket that says nothing lands nowhere.
    const ticket = issueTicket(
      { scope: 'terminal', userKey: workbenchUserKey(user.userId, token) },
      token,
    );
    return Response.json({ url: terminalUrl(publicOrigin(request), ticket) }, { headers });
  } catch (error) {
    if (error instanceof WorkbenchError)
      return Response.json({ error: error.message }, { status: error.status, headers });
    throw error;
  }
}
