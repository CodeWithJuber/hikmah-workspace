import type { SecretMetadata } from '../lib/playground/secret-reference';
export class SecretError extends Error {
  status: number;
  constructor(message: string, status?: number);
}
export interface SecretStore {
  list(userId: string): Promise<SecretMetadata[]>;
  save(userId: string, input: unknown): Promise<void>;
  remove(userId: string, name: unknown): Promise<void>;
  resolve(userId: string, name: string, destination: string, optional?: boolean): Promise<string>;
}
export function createSecretStore(db?: unknown): SecretStore;
export function validateDestination(destination: unknown): string;
