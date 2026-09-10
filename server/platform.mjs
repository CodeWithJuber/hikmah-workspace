import { getStorage } from './storage.mjs';
// Host adapter: API routes retain prepared queries and atomic revision checks.
export const env = {
  get DB() { return getStorage().DB; },
  get BUCKET() { return getStorage().BUCKET; },
  get HIKMAH_OWNER_EMAIL() { return process.env.HIKMAH_OWNER_EMAIL || ''; },
};
