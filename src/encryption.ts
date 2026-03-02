import crypto from 'crypto';
import logger from './logger';

const encLogger = logger.child({ subsystem: 'encryption' });

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SEPARATOR = ':';

function getMasterKey(): Buffer {
  const keyHex = process.env.CONVERSATION_ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      'CONVERSATION_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)',
    );
  }
  return Buffer.from(keyHex, 'hex');
}

/**
 * Derive a per-user encryption key using HKDF.
 * master key + user's OIDC sub → unique 32-byte key per user.
 */
export function deriveUserKey(userSub: string): Buffer {
  const masterKey = getMasterKey();
  return Buffer.from(
    crypto.hkdfSync('sha256', masterKey, userSub, 'fluxhaus-conversations', 32),
  );
}

/**
 * Encrypt plaintext using AES-256-GCM with a per-user key.
 * Returns "iv:authTag:ciphertext" (all hex-encoded).
 */
export function encrypt(plaintext: string, userSub: string): string {
  const key = deriveUserKey(userSub);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return [iv.toString('hex'), authTag, encrypted].join(SEPARATOR);
}

/**
 * Decrypt a value produced by encrypt().
 * Input format: "iv:authTag:ciphertext" (all hex-encoded).
 */
export function decrypt(encryptedValue: string, userSub: string): string {
  const parts = encryptedValue.split(SEPARATOR);
  if (parts.length !== 3) {
    encLogger.error('Invalid encrypted value format');
    throw new Error('Invalid encrypted value format');
  }

  const [ivHex, authTagHex, ciphertext] = parts;
  const key = deriveUserKey(userSub);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
