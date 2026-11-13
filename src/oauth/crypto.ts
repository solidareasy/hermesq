/** AES-256-GCM helpers. Ciphertext format: base64(iv[12] || ciphertext+tag). */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Accepts 32 bytes as base64 or 64 hex chars. */
export function parseKeyMaterial(value: string): Uint8Array {
  const v = value.trim();
  let bytes: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(v)) {
    bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(v.slice(i * 2, i * 2 + 2), 16);
  } else {
    bytes = b64ToBytes(v);
  }
  if (bytes.length !== 32) throw new Error('OAUTH_ENCRYPTION_KEY must be 32 bytes (base64 or 64 hex chars)');
  return bytes;
}

export function generateKeyMaterial(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToB64(bytes);
}

export async function importAesKey(material: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', parseKeyMaterial(material), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptString(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToB64(out);
}

export async function decryptString(key: CryptoKey, data: string): Promise<string> {
  const bytes = b64ToBytes(data);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}
