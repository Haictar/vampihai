// AES-256-GCM encryption for stored provider API keys. Server-only.
// The 256-bit key is derived (SHA-256) from the HAI_KEY_ENCRYPTION_SECRET project secret,
// and each ciphertext is bound to its key row id via additional authenticated data.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getAesKey(): Promise<CryptoKey> {
  const secret = process.env["HAI_KEY_ENCRYPTION_SECRET"];
  if (!secret) throw new Error("Key encryption is not configured on the server.");
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(
  plaintext: string,
  boundTo: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await getAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(boundTo) },
    key,
    encoder.encode(plaintext),
  );
  return { ciphertext: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv) };
}

export async function decryptSecret(ciphertext: string, iv: string, boundTo: string): Promise<string> {
  const key = await getAesKey();
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv), additionalData: encoder.encode(boundTo) },
    key,
    fromBase64(ciphertext),
  );
  return decoder.decode(decrypted);
}
