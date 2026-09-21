import { getStorage } from '../../server/storage.mjs';
import { createSecretStore } from '../../server/workspace-secrets.mjs';
import { createTypeformService, type TypeformService } from './typeform-service.ts';
import { createTypeformGrantStore } from './typeform-store.ts';
import type { TypeformToolContext } from './typeform-tools.ts';

let service: TypeformService | undefined;
export function typeformService(): TypeformService {
  service ??= createTypeformService({
    secrets: createSecretStore(),
    grants: createTypeformGrantStore(getStorage().raw),
  });
  return service;
}

/** userId comes only from the authenticated run, never tool arguments. */
export async function typeformRunContext(userId: string, signal?: AbortSignal): Promise<TypeformToolContext | undefined> {
  const connected = typeformService();
  if (!(await connected.status(userId)).connected) return undefined;
  return {
    forms: (page) => connected.forms(userId, page, signal),
    responses: (formId, before) => connected.responses(userId, formId, before, signal),
  };
}
