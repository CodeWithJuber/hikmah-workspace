import { NextResponse } from 'next/server';
import { systemOne } from '@/lib/integrations/jev-client';

/** Optional typed routing proposal. Callers must still apply deterministic gates. */
export async function POST(request: Request) {
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
