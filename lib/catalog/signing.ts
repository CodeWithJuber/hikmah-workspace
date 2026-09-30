/** Ed25519 manifest signing (PR-26: curated catalog).
 *
 * The signature covers the canonical manifest bytes — the manifest JSON with
 * keys sorted and no insignificant whitespace — so a signature stays valid
 * regardless of how the JSON was pretty-printed, and any change to any field
 * (name, version, description, permissions, entrypoint, homepage) breaks it.
 *
 * Key custody is the owner's job: the private signing key lives in the
 * workspace secrets vault (or `CATALOG_SIGNING_KEY` when seeding), never in
 * this repo. What ships here is verification — the public key committed at
 * `connectors/catalog.pub` — plus the signing primitives the owner's
 * `scripts/seed-catalog.mjs` uses to mint the seed signatures.
 *
 * Pure over its inputs, importing only node:crypto, so tests drive it
 * directly and it never touches Next.
 */
import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  generateKeyPairSync,
  createHash,
} from 'node:crypto';
import type { ConnectorManifest } from './manifest.ts';

/** A signed manifest as stored: the manifest plus its signature and the
 * public key that made it. `signer` is the base64 DER of the Ed25519 public
 * key — self-identifying, so verification needs no key lookup. */
export interface SignedManifest {
  manifest: ConnectorManifest;
  /** base64 Ed25519 signature over the canonical manifest bytes. */
  signature: string;
  /** base64 DER (SPKI) of the Ed25519 public key that signed it. */
  signer: string;
}

/** The canonical bytes a signature covers: JSON with keys sorted
 * recursively and no whitespace. Key order in the input does not matter;
 * field values do. */
export function canonicalBytes(manifest: ConnectorManifest): Buffer {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort())
        out[key] = sort((value as Record<string, unknown>)[key]);
      return out;
    }
    return value;
  };
  return Buffer.from(JSON.stringify(sort(manifest)), 'utf8');
}

/** Mint a fresh Ed25519 keypair. Returns base64 DER for both halves; the
 * caller decides custody (the private half must never be committed). */
export function generateSigningKey(): { publicKeyB64: string; privateKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKeyB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

/** Sign the manifest's canonical bytes. The private key is base64 PKCS#8 DER.
 * Ed25519 signs the message directly (one-shot `sign`), not a digest. */
export function signManifest(manifest: ConnectorManifest, privateKeyB64: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return sign(null, canonicalBytes(manifest), key).toString('base64');
}

/** Verify a base64 signature against the manifest and a base64 SPKI DER
 * public key. Any failure — bad key, bad signature encoding, tampered
 * manifest — is a plain false, never a throw, so callers can fail closed
 * without a try/catch. */
export function verifyManifest(
  manifest: ConnectorManifest,
  signatureB64: string,
  publicKeyB64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const signature = Buffer.from(signatureB64, 'base64');
    if (signature.length !== 64) return false;
    return verify(null, canonicalBytes(manifest), key, signature);
  } catch {
    return false;
  }
}

/** Verify a whole signed manifest: the signature must check out against the
 * manifest it is attached to and the signer it names. */
export function verifySignedManifest(signed: SignedManifest): boolean {
  return verifyManifest(signed.manifest, signed.signature, signed.signer);
}

/** Stable identity for a public key: sha256 of the DER, hex. Used for
 * display and for the "same signer" update check. */
export function fingerprint(publicKeyB64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex');
}
