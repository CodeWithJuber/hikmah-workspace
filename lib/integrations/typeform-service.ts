import { createHash } from 'node:crypto';
import type { SecretStore } from '../../server/workspace-secrets.mjs';
import {
  createTypeformClient, TypeformError, typeformId, typeformPage, typeformToken,
} from './typeform-client.ts';
import type { TypeformGrantStore } from './typeform-store.ts';
import type { TypeformForms, TypeformStatus } from './typeform-types.ts';

export const TYPEFORM_SECRET = 'TYPEFORM_PLATFORM_TOKEN';
export const TYPEFORM_DESTINATION = 'integration:typeform';
const fingerprint = (key: string) => createHash('sha256').update(key).digest('hex');

export function createTypeformService(deps: {
  secrets: SecretStore;
  grants: TypeformGrantStore;
  fetchImpl?: typeof fetch;
}) {
  const { secrets, grants } = deps;
  // Per actor, bounded and process-local. Provider limits still apply.
  const usage = new Map<string, { at: number; count: number }>();
  function rate(userId: string) {
    const now = Date.now();
    const previous = usage.get(userId);
    if (previous && now - previous.at < 60_000) {
      if (previous.count >= 30) throw new TypeformError('Wait a minute before refreshing Typeform again.', 429);
      previous.count += 1;
    } else usage.set(userId, { at: now, count: 1 });
    if (usage.size > 2000)
      for (const [id, row] of usage) if (now - row.at >= 60_000) usage.delete(id);
  }
  function owner(userId: string) {
    const ownerId = grants.ownerId();
    if (!ownerId || userId !== ownerId)
      throw new TypeformError('Only the Super Admin can manage this connection.', 403);
    return ownerId;
  }
  async function connection() {
    const ownerId = grants.ownerId();
    if (!ownerId) throw new TypeformError('Typeform has not been connected by the owner.', 409);
    const token = await secrets.resolve(ownerId, TYPEFORM_SECRET, TYPEFORM_DESTINATION, true);
    if (!token) throw new TypeformError('Ask the owner to connect Typeform in Integrations.', 409);
    return { ownerId, token, key: fingerprint(token) };
  }
  async function access(userId: string, formId?: string) {
    const connected = await connection();
    if (userId !== connected.ownerId && formId && !grants.allows(connected.ownerId, connected.key, userId, formId))
      throw new TypeformError('This form has not been shared with your account.', 403);
    return connected;
  }
  async function unchanged(userId: string, connected: Awaited<ReturnType<typeof connection>>, formId?: string) {
    const current = await access(userId, formId);
    if (current.key !== connected.key || current.ownerId !== connected.ownerId)
      throw new TypeformError('The Typeform connection changed. Refresh and try again.', 409);
  }
  const client = (token: string, signal?: AbortSignal) =>
    createTypeformClient(token, { fetchImpl: deps.fetchImpl, signal });
  return {
    async status(userId: string): Promise<TypeformStatus> {
      const ownerId = grants.ownerId();
      if (!ownerId) return { connected: false, owner: false };
      const isOwner = userId === ownerId;
      const metadata = (await secrets.list(ownerId)).find(
        (entry) => entry.name === TYPEFORM_SECRET && entry.destination === TYPEFORM_DESTINATION,
      );
      if (!metadata) return { connected: false, owner: isOwner, ...(isOwner ? { grants: [] } : {}) };
      const connected = await connection();
      const visibleGrants = grants.list(ownerId, connected.key, isOwner ? undefined : userId);
      return {
        connected: isOwner || visibleGrants.length > 0,
        owner: isOwner,
        ...(isOwner ? { updatedAt: metadata.updatedAt, grants: visibleGrants } : {}),
      };
    },
    async save(userId: string, input: unknown, signal?: AbortSignal) {
      const ownerId = owner(userId);
      const token = typeformToken(input);
      rate(userId);
      await client(token, signal).forms(1);
      // Token replacement immediately invalidates old credential-bound grants,
      // even if a crash prevents the following cleanup from running.
      const previous = await secrets.resolve(ownerId, TYPEFORM_SECRET, TYPEFORM_DESTINATION, true);
      await secrets.save(ownerId, { name: TYPEFORM_SECRET, destination: TYPEFORM_DESTINATION, value: token });
      if (previous !== token) grants.clear(ownerId);
    },
    async disconnect(userId: string) {
      const ownerId = owner(userId);
      grants.clear(ownerId);
      await secrets.remove(ownerId, TYPEFORM_SECRET);
    },
    async test(userId: string, signal?: AbortSignal) {
      owner(userId);
      rate(userId);
      const connected = await connection();
      await client(connected.token, signal).forms(1);
      await unchanged(userId, connected);
      return { ok: true };
    },
    async forms(userId: string, page = 1, signal?: AbortSignal): Promise<TypeformForms> {
      page = typeformPage(page);
      const connected = await access(userId);
      if (userId !== connected.ownerId) {
        const own = grants.list(connected.ownerId, connected.key, userId);
        return {
          items: own.slice((page - 1) * 25, page * 25).map((grant) => ({ id: grant.formId, title: grant.title })),
          page, pageCount: Math.ceil(own.length / 25), total: own.length,
        };
      }
      rate(userId);
      const result = await client(connected.token, signal).forms(page);
      await unchanged(userId, connected);
      return result;
    },
    async responses(userId: string, rawId: string, before?: string, signal?: AbortSignal) {
      const id = typeformId(rawId);
      const connected = await access(userId, id);
      rate(userId);
      const result = await client(connected.token, signal).responses(id, before);
      // Revocation while a provider request is in flight discards the result.
      await unchanged(userId, connected, id);
      return result;
    },
    async grant(userId: string, rawId: unknown, rawEmail: unknown, signal?: AbortSignal) {
      const ownerId = owner(userId), id = typeformId(rawId);
      if (typeof rawEmail !== 'string' || rawEmail.length > 254 || !rawEmail.includes('@'))
        throw new TypeformError('Enter the email of an existing Hikmah account.');
      const target = grants.findUser(rawEmail.trim().toLowerCase());
      if (!target) throw new TypeformError('That person needs a Hikmah account before you can share this form.', 404);
      if (target === ownerId) throw new TypeformError('The owner already has access to this form.');
      rate(userId);
      const connected = await connection();
      const existing = grants.list(ownerId, connected.key);
      if (existing.length >= 2000 || existing.filter((grant) => grant.userId === target).length >= 100)
        throw new TypeformError('This connection has reached its sharing limit. Remove an unused grant first.');
      const detail = await client(connected.token, signal).form(id);
      await unchanged(userId, connected);
      grants.save(ownerId, connected.key, target, id, detail.title);
    },
    revoke(userId: string, rawId: unknown, rawTarget: unknown) {
      const ownerId = owner(userId), id = typeformId(rawId);
      if (typeof rawTarget !== 'string' || !rawTarget || rawTarget.length > 200)
        throw new TypeformError('Choose an account to remove.');
      grants.remove(ownerId, rawTarget, id);
    },
  };
}
export type TypeformService = ReturnType<typeof createTypeformService>;
