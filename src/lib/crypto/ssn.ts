/**
 * SSN encryption wrapper.
 * Uses AES_ENCRYPTION_KEY (distinct from SMTP_ENCRYPTION_KEY so the two
 * concerns can be rotated independently).
 *
 * Rotation: set AES_ENCRYPTION_KEY_V2 to a new secret alongside the
 * existing AES_ENCRYPTION_KEY, then set AES_SSN_KEY_VERSION=2. New
 * encryptions will write v2 ciphertext while old v1 rows remain
 * decryptable via AES_ENCRYPTION_KEY. A separate rotation script can
 * then re-encrypt v1 rows in the background.
 *
 * Server-only.
 */

import {
  decryptWith,
  encryptWith,
  isEnvKeyConfiguredForVersion,
} from "./aes";

const ENV_VAR = "AES_ENCRYPTION_KEY";
const VERSION_ENV_VAR = "AES_SSN_KEY_VERSION";

export function getCurrentSsnKeyVersion(): number {
  const raw = process.env[VERSION_ENV_VAR];
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `${VERSION_ENV_VAR} must be a positive integer; got "${raw}"`,
    );
  }
  return n;
}

export interface EncryptedSsn {
  ciphertext: string;
  keyVersion: number;
}

export function encryptSsn(plaintext: string): EncryptedSsn {
  const normalized = plaintext.replace(/\D/g, "");
  if (normalized.length !== 9) {
    throw new Error("SSN must be exactly 9 digits");
  }
  const keyVersion = getCurrentSsnKeyVersion();
  const ciphertext = encryptWith(ENV_VAR, normalized, keyVersion);
  return { ciphertext, keyVersion };
}

export function decryptSsn(ciphertext: string): string {
  return decryptWith(ENV_VAR, ciphertext);
}

export function maskSsn(ciphertext: string | null | undefined): string {
  if (!ciphertext) return "";
  return "•••-••-••••";
}

export function isSsnEncryptionConfigured(): boolean {
  // Only the current version's env var is required. Older versions may or
  // may not be loaded depending on where rotation is in progress; decrypt
  // paths surface their own error if an older ciphertext is touched
  // without the matching env var. Requiring the base var here would break
  // the post-rotation state where v1 has been fully re-encrypted to v2
  // and the old key is intentionally removed.
  return isEnvKeyConfiguredForVersion(ENV_VAR, getCurrentSsnKeyVersion());
}
