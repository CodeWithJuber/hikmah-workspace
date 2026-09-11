import { publicOrigin } from '../server/origin.ts';
import { env } from '@/server/platform.mjs';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { initialKernel, type KernelState } from './core';
export class KernelHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function database() {
  if (!env.DB)
    throw new KernelHttpError(
      503,
      'Workspace storage is unavailable. Your input is preserved; try again.',
    );
  return env.DB;
}
export async function identity() {
  const user = await getChatGPTUser();
  if (!user) throw new KernelHttpError(401, 'Sign in to your private workspace.');
  return user;
}
export async function ownerIdentity() {
  const user = await identity();
  const db = database();
  let owner = await db
    .prepare('SELECT user_id FROM kernel_owners WHERE id = ?')
    .bind('owner')
    .first<{ user_id: string }>();
  // Bootstrap only the configured owner with a server-verified session. Subsequent checks use the site-scoped immutable identity.
  if (
    !owner &&
    env.HIKMAH_OWNER_EMAIL &&
    user.email.toLowerCase() === env.HIKMAH_OWNER_EMAIL.toLowerCase()
  ) {
    await db
      .prepare(
        'INSERT INTO kernel_owners (id,user_id,created_at) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind('owner', user.userId, new Date().toISOString())
      .run();
    owner = await db
      .prepare('SELECT user_id FROM kernel_owners WHERE id = ?')
      .bind('owner')
      .first<{ user_id: string }>();
  }
  if (owner?.user_id !== user.userId)
    throw new KernelHttpError(403, 'Super Admin access is restricted to the configured owner.');
  return user;
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== publicOrigin(request))
    throw new KernelHttpError(403, 'A same-origin request is required.');
}
export async function readState(userId: string) {
  const row = await database()
    .prepare('SELECT body,revision FROM kernel_states WHERE user_id = ?')
    .bind(userId)
    .first<{ body: string; revision: number }>();
  return row
    ? { state: JSON.parse(row.body) as KernelState, revision: row.revision }
    : { state: initialKernel(), revision: -1 };
}
export async function writeState(userId: string, state: KernelState, revision: number) {
  const body = JSON.stringify(state);
  if (new TextEncoder().encode(body).length > 1500000)
    throw new KernelHttpError(413, 'Learning state is too large. Export and curate examples.');
  const result =
    revision === -1
      ? await database()
          .prepare(
            'INSERT INTO kernel_states (user_id,body,revision,updated_at) VALUES (?,?,0,?) ON CONFLICT(user_id) DO NOTHING',
          )
          .bind(userId, body, new Date().toISOString())
          .run()
      : await database()
          .prepare(
            'UPDATE kernel_states SET body = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?',
          )
          .bind(body, new Date().toISOString(), userId, revision)
          .run();
  if (result.meta.changes !== 1)
    throw new KernelHttpError(409, 'Another tab updated the model. Refresh and try again.');
  return revision + 1;
}
export function failure(e: unknown) {
  const status = e instanceof KernelHttpError ? e.status : 400;
  return Response.json(
    { error: e instanceof Error ? e.message : 'Request failed.' },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}
