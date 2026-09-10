import { getStorage } from '../server/storage.mjs';
import { initializeAuth } from '../server/auth.mjs';
process.umask(0o077);
const storage = getStorage();
await initializeAuth();
storage.close();
console.info('Hikmah storage and authentication are ready.');
