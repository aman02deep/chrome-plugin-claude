/**
 * crypto.js — AES-GCM encryption / decryption via Web Crypto API
 *
 * Key derivation:  PBKDF2 (SHA-256, 310,000 iterations) from master password + random salt
 * Encryption:      AES-GCM with random 96-bit IV per operation
 * Storage format:  base64(salt) + ':' + base64(iv) + ':' + base64(ciphertext)
 *
 * The derived key is NEVER stored — it lives only in memory while unlocked.
 */

const PBKDF2_ITERATIONS = 310_000;
const KEY_LENGTH = 256;

/** Encode ArrayBuffer → base64 string */
function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

/** Decode base64 string → ArrayBuffer */
function b64ToBuf(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/**
 * Derive an AES-GCM CryptoKey from a master password + salt.
 * @param {string} password
 * @param {ArrayBuffer} salt
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Hash master password for storage-based verification.
 * Uses PBKDF2 with a fixed known salt — output is deterministic for the same password.
 * Store only this hash; never derive or store the actual key.
 * @param {string} password
 * @returns {Promise<string>} hex string
 */
export async function hashMasterPassword(password) {
  const enc = new TextEncoder();
  const fixedSalt = enc.encode('claude-session-manager-salt-v1');
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fixedSalt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    true, // extractable so we can export it as the "hash"
    ['encrypt']
  );
  const exported = await crypto.subtle.exportKey('raw', derivedKey);
  return bufToB64(exported);
}

/**
 * Encrypt a plaintext string using a derived key.
 * @param {string} plaintext
 * @param {CryptoKey} key
 * @returns {Promise<string>} encoded as "salt:iv:ciphertext" (all base64)
 */
export async function encrypt(plaintext, key) {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );
  return bufToB64(iv.buffer) + ':' + bufToB64(ciphertext);
}

/**
 * Decrypt a ciphertext string using a derived key.
 * @param {string} encoded — "iv:ciphertext" (base64)
 * @param {CryptoKey} key
 * @returns {Promise<string>} plaintext
 */
export async function decrypt(encoded, key) {
  const parts = encoded.split(':');
  if (parts.length !== 2) throw new Error('Invalid ciphertext format');
  const [ivB64, ciphertextB64] = parts;
  const iv = b64ToBuf(ivB64);
  const ciphertext = b64ToBuf(ciphertextB64);
  const dec = new TextDecoder();
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return dec.decode(plainBuf);
}

/**
 * Derive an AES-GCM key from a master password.
 * Call this once on unlock; keep the returned key in memory.
 * @param {string} password
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKeyFromPassword(password) {
  const enc = new TextEncoder();
  // Use a deterministic salt tied to this extension so the key is stable per password
  const salt = enc.encode('claude-session-manager-aes-salt-v1');
  return deriveKey(password, salt);
}

/**
 * Encrypt a JS object (will be JSON-stringified).
 */
export async function encryptObject(obj, key) {
  return encrypt(JSON.stringify(obj), key);
}

/**
 * Decrypt to a JS object.
 */
export async function decryptObject(encoded, key) {
  const json = await decrypt(encoded, key);
  return JSON.parse(json);
}
