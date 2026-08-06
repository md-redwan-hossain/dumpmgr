import { argon2id, argon2Verify } from "hash-wasm";

const ARGON_OPTS = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65536,
  hashLength: 32,
} as const;

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function toB64(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

export async function hashMasterPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return argon2id({
    password,
    salt,
    ...ARGON_OPTS,
    outputType: "encoded",
  });
}

export async function verifyMasterPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: encodedHash });
  } catch {
    return false;
  }
}

/** Derive 32-byte AES key from master password + salt (Argon2id). */
export async function deriveAesKey(
  masterPassword: string,
  saltB64: string,
): Promise<CryptoKey> {
  const raw = await argon2id({
    password: masterPassword,
    salt: fromB64(saltB64),
    ...ARGON_OPTS,
    outputType: "binary",
  });
  return crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export function newKdfSalt(): string {
  return toB64(randomBytes(16));
}

/** AES-256-GCM: returns base64(iv || ciphertext+tag). */
export async function encryptSecret(
  key: CryptoKey,
  plaintext: string,
): Promise<string> {
  const iv = randomBytes(12);
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> }, key, encoded as Uint8Array<ArrayBuffer>),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return toB64(out);
}

export async function decryptSecret(
  key: CryptoKey,
  payloadB64: string,
): Promise<string> {
  const data = fromB64(payloadB64);
  const iv = data.slice(0, 12);
  const cipher = data.slice(12);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    cipher,
  );
  return new TextDecoder().decode(plain);
}

export async function encryptBytes(
  key: CryptoKey,
  data: Uint8Array,
): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> }, key, data as Uint8Array<ArrayBuffer>),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return out;
}

export async function decryptBytes(
  key: CryptoKey,
  data: Uint8Array,
): Promise<Uint8Array> {
  const iv = data.slice(0, 12);
  const cipher = data.slice(12);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher),
  );
}
