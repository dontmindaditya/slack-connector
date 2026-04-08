import crypto from 'crypto';

/**
 * AES-256-GCM symmetric encryption for Slack bot tokens stored at rest.
 *
 * Format of an encrypted value:
 *   enc:v1:<iv_hex>:<auth_tag_hex>:<ciphertext_hex>
 *
 * The prefix lets us detect at runtime whether a stored value is already
 * plaintext (e.g. legacy rows written before encryption was enabled) so
 * decrypt is always safe to call without knowing the stored state.
 *
 * Both functions accept an optional keyHex (TOKEN_ENCRYPTION_KEY from env).
 * If keyHex is absent, they are identity functions — this enables graceful
 * operation when encryption is not configured.
 */

const ALGORITHM = 'aes-256-gcm' as const;
const IV_BYTES = 12;      // 96-bit IV — NIST recommended for GCM
const TAG_BYTES = 16;     // 128-bit auth tag — GCM default
const PREFIX = 'enc:v1:';

/**
 * Encrypts a plaintext string.
 * Returns `plaintext` unchanged if no key is configured.
 */
export function encryptToken(plaintext: string, keyHex?: string): string {
  if (!keyHex) return plaintext;

  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a token previously produced by encryptToken().
 *
 * If the value does not start with the enc:v1: prefix (plaintext or from
 * a row written before encryption was enabled), returns it unchanged.
 * This means decrypt is safe to call on any stored token value.
 */
export function decryptToken(value: string, keyHex?: string): string {
  if (!keyHex || !value.startsWith(PREFIX)) return value;

  const key = Buffer.from(keyHex, 'hex');
  const inner = value.slice(PREFIX.length);
  const colonOne = inner.indexOf(':');
  const colonTwo = inner.indexOf(':', colonOne + 1);

  if (colonOne === -1 || colonTwo === -1) {
    throw new Error('[Encryption] Malformed enc:v1 token — expected iv:tag:ciphertext');
  }

  const iv = Buffer.from(inner.slice(0, colonOne), 'hex');
  const authTag = Buffer.from(inner.slice(colonOne + 1, colonTwo), 'hex');
  const encrypted = Buffer.from(inner.slice(colonTwo + 1), 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8');
}
