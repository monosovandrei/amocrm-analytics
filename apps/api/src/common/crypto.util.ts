import * as crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function deriveKey(keyRaw: string): Buffer {
  if (!keyRaw) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY env var is not set');
  }
  if (keyRaw.length === 64 && /^[0-9a-fA-F]+$/.test(keyRaw)) {
    return Buffer.from(keyRaw, 'hex');
  }
  return crypto.createHash('sha256').update(keyRaw).digest();
}

export function encryptJson(data: object, keyRaw: string): string {
  const key = deriveKey(keyRaw);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv) as crypto.CipherGCM;
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptJson<T>(encryptedBase64: string, keyRaw: string): T {
  const key = deriveKey(keyRaw);
  const packed = Buffer.from(encryptedBase64, 'base64');
  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGO, key, iv) as crypto.DecipherGCM;
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}
