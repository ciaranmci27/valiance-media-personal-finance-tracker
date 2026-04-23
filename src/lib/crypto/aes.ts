/**
 * AES-256-GCM with per-call env-var selection and versioned ciphertext.
 *
 * The env var holds any string; SHA-256 derives the 32-byte AES key.
 * Separating callers by env var (e.g. AES_ENCRYPTION_KEY for SSN,
 * SMTP_ENCRYPTION_KEY for SMTP passwords) isolates blast radius so
 * rotating one does not invalidate ciphertext protected by the other.
 *
 * Rotation: each caller (env-var prefix) can hold multiple versions. v1
 * reads from `${BASE}`; v2 reads from `${BASE}_V2`; v3 from `${BASE}_V3`,
 * etc. encryptWith(base, pt, version) writes under the requested version;
 * decryptWith(base, ct) auto-detects the version from the ciphertext.
 *
 * Output format: "v<N>:iv_hex:tag_hex:cipher_hex". Legacy ciphertext
 * without a version prefix (3 colon-separated parts) is still accepted
 * on read and treated as v1.
 *
 * Server-only. Do not import from client components.
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function envVarForVersion(baseEnvVar: string, version: number): string {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Invalid key version: ${version}`);
  }
  return version === 1 ? baseEnvVar : `${baseEnvVar}_V${version}`;
}

function deriveKey(envVarName: string): Buffer {
  const secret = process.env[envVarName];
  if (!secret) {
    throw new Error(`${envVarName} environment variable is not set`);
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptWith(
  baseEnvVar: string,
  plaintext: string,
  version: number = 1,
): string {
  const envVarName = envVarForVersion(baseEnvVar, version);
  const key = deriveKey(envVarName);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const tag = cipher.getAuthTag();

  return `v${version}:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

interface ParsedCiphertext {
  version: number;
  iv: Buffer;
  tag: Buffer;
  ciphertextHex: string;
}

function parseCiphertext(encrypted: string): ParsedCiphertext {
  const parts = encrypted.split(":");
  if (parts.length === 3) {
    // Legacy format predates versioning; treat as v1.
    return {
      version: 1,
      iv: Buffer.from(parts[0], "hex"),
      tag: Buffer.from(parts[1], "hex"),
      ciphertextHex: parts[2],
    };
  }
  if (parts.length === 4 && /^v\d+$/.test(parts[0])) {
    const version = Number(parts[0].slice(1));
    if (!Number.isInteger(version) || version < 1) {
      throw new Error("Invalid encrypted format (bad version)");
    }
    return {
      version,
      iv: Buffer.from(parts[1], "hex"),
      tag: Buffer.from(parts[2], "hex"),
      ciphertextHex: parts[3],
    };
  }
  throw new Error("Invalid encrypted format (expected v<N>:iv:tag:cipher)");
}

export function decryptWith(baseEnvVar: string, encrypted: string): string {
  const parsed = parseCiphertext(encrypted);
  const envVarName = envVarForVersion(baseEnvVar, parsed.version);
  const key = deriveKey(envVarName);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, parsed.iv);
  decipher.setAuthTag(parsed.tag);

  let decrypted = decipher.update(parsed.ciphertextHex, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

export function getCiphertextVersion(encrypted: string): number {
  return parseCiphertext(encrypted).version;
}

export function isEnvKeyConfigured(envVarName: string): boolean {
  return !!process.env[envVarName];
}

export function isEnvKeyConfiguredForVersion(
  baseEnvVar: string,
  version: number,
): boolean {
  return isEnvKeyConfigured(envVarForVersion(baseEnvVar, version));
}
