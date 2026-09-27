import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { systemOne } from '@/lib/integrations/jev-client';

/** Typed routing proposal (TypeSafe System One).
 *
 * v10: authenticated. Every call spends the deployment's TYPESAFE_API_KEY, so
 * anonymous callers are refused with 401. Callers must still apply
 * deterministic gates to the decision — a typed proposal is not a verdict.
 */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  try {
    const body = (await request.json()) as { task?: unknown };
    const task = typeof body.task === 'string' ? body.task.trim().slice(0, 8_000) : '';
    if (!task) return NextResponse.json({ decision: null }, { status: 400 });
    const decision = await systemOne({ task, gate: 'preflight' }, [
      {
        id: 'route',
        type: 'choice',
        prompt: 'Choose the safest execution lane.',
        options: ['clarify', 'standard', 'deep-research'],
      },
    ]);
    return NextResponse.json({ decision });
  } catch {
    return NextResponse.json({ decision: null });
  }
}
