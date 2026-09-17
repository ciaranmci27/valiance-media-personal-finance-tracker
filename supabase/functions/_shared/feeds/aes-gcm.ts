/**
 * Reads the app's versioned AES-256-GCM ciphertext ("v<N>:iv:tag:cipher",
 * hex, legacy "iv:tag:cipher" as v1) with Web Crypto, so the sync-feeds edge
 * function decrypts what src/lib/crypto/aes.ts wrote without Node's crypto
 * module. The secret is hashed with SHA-256 to the 32-byte key, as in Node.
 */
function hexBytes(hex: string, label: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex))
    throw new Error(`Invalid encrypted format (bad ${label})`);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
export function parseVersionedCiphertext(encrypted: string): {
  version: number;
  iv: Uint8Array;
  tag: Uint8Array;
  cipher: Uint8Array;
} {
  const parts = encrypted.split(":");
  let version = 1,
    body: string[];
  if (parts.length === 3) body = parts;
  else if (parts.length === 4 && /^v\d+$/.test(parts[0])) {
    version = Number(parts[0].slice(1));
    body = parts.slice(1);
  } else
    throw new Error("Invalid encrypted format (expected v<N>:iv:tag:cipher)");
  if (!Number.isInteger(version) || version < 1)
    throw new Error("Invalid encrypted format (bad version)");
  return {
    version,
    iv: hexBytes(body[0], "iv"),
    tag: hexBytes(body[1], "tag"),
    cipher: hexBytes(body[2], "cipher"),
  };
}
/** `secretFor` returns the key material for a ciphertext version, or nothing when that key is not configured. */
export async function decryptVersioned(
  encrypted: string,
  secretFor: (version: number) => string | undefined,
): Promise<string> {
  const parsed = parseVersionedCiphertext(encrypted);
  const secret = secretFor(parsed.version);
  if (!secret)
    throw new Error(`Encryption key for version ${parsed.version} is not set`);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  // Web Crypto expects the authentication tag appended to the ciphertext.
  const sealed = new Uint8Array(parsed.cipher.length + parsed.tag.length);
  sealed.set(parsed.cipher);
  sealed.set(parsed.tag, parsed.cipher.length);
  const plain = await crypto.subtle.decrypt(
    // The cast keeps older and newer TypeScript libs (Uint8Array generics) happy.
    { name: "AES-GCM", iv: parsed.iv as BufferSource, tagLength: 128 },
    key,
    sealed as BufferSource,
  );
  return new TextDecoder().decode(plain);
}
