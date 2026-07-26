import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";
import { z } from "zod";
import {
  decryptSecret,
  deriveAesKey,
  encryptSecret,
  hashMasterPassword,
  newKdfSalt,
  verifyMasterPassword,
} from "./crypto.ts";

export const MetadataSchema = z.object({
  masterPassword: z.string().nullable().optional(),
  kdfSalt: z.string().nullable().optional(),
  dbPasswords: z.record(z.string(), z.string()).default({}),
  encId: z.string().nullable().optional(),
});

export type Metadata = z.infer<typeof MetadataSchema>;

export type Session = {
  masterPassword: string | null;
  aesKey: CryptoKey | null;
  metadata: Metadata;
  metadataPath: string;
};

const MAGIC = new TextEncoder().encode("DBSM");
const VERSION = 1;

export function newEncId(): string {
  return crypto.randomUUID().replaceAll("-", "").toUpperCase();
}

export function metadataPathForConfig(configPath: string): string {
  return join(dirname(configPath), "metadata");
}

function encodeBinary(meta: Metadata): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const gz = gzipSync(json);
  const out = new Uint8Array(MAGIC.length + 1 + gz.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = VERSION;
  out.set(gz, MAGIC.length + 1);
  return out;
}

function decodeBinary(buf: Uint8Array): Metadata {
  if (buf.length < MAGIC.length + 2) {
    throw new Error("Invalid metadata file (too short)");
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (buf[i] !== MAGIC[i]) {
      throw new Error("Invalid metadata file (bad magic)");
    }
  }
  const version = buf[MAGIC.length];
  if (version !== VERSION) {
    throw new Error(`Unsupported metadata version: ${version}`);
  }
  const json = gunzipSync(buf.subarray(MAGIC.length + 1));
  const raw: unknown = JSON.parse(new TextDecoder().decode(json));
  const parsed = MetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Invalid metadata payload");
  }
  return parsed.data;
}

async function migrateFromJsonIfNeeded(binaryPath: string): Promise<Metadata | null> {
  const jsonPath = join(dirname(binaryPath), "metadata.json");
  const jsonFile = Bun.file(jsonPath);
  if (!(await jsonFile.exists())) return null;
  let raw: unknown;
  try {
    raw = await jsonFile.json();
  } catch {
    throw new Error(`Invalid legacy metadata.json: ${jsonPath}`);
  }
  const parsed = MetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid legacy metadata.json: ${jsonPath}`);
  }
  const meta: Metadata = {
    ...parsed.data,
    encId: parsed.data.encId || newEncId(),
  };
  await writeMetadata(binaryPath, meta);
  await rm(jsonPath, { force: true });
  return meta;
}

export async function loadMetadata(path: string): Promise<Metadata> {
  const file = Bun.file(path);
  if (await file.exists()) {
    const buf = new Uint8Array(await file.arrayBuffer());
    return decodeBinary(buf);
  }
  const migrated = await migrateFromJsonIfNeeded(path);
  if (migrated) return migrated;
  return { masterPassword: null, kdfSalt: null, dbPasswords: {}, encId: null };
}

export async function writeMetadata(
  path: string,
  meta: Metadata,
): Promise<void> {
  await Bun.write(path, encodeBinary(meta));
}

export async function createMetadataWithMaster(
  path: string,
  masterPassword: string,
): Promise<Metadata> {
  const meta: Metadata = {
    masterPassword: await hashMasterPassword(masterPassword),
    kdfSalt: newKdfSalt(),
    dbPasswords: {},
    encId: newEncId(),
  };
  await writeMetadata(path, meta);
  return meta;
}

export async function emptyMetadata(path: string): Promise<Metadata> {
  const meta: Metadata = {
    masterPassword: null,
    kdfSalt: null,
    dbPasswords: {},
    encId: null,
  };
  await writeMetadata(path, meta);
  return meta;
}

export async function unlockSession(
  metadataPath: string,
  masterPassword: string,
): Promise<Session> {
  let metadata = await loadMetadata(metadataPath);
  if (!metadata.masterPassword || !metadata.kdfSalt) {
    throw new Error("metadata has no master password; run config init again");
  }
  if (!metadata.encId) {
    metadata = { ...metadata, encId: newEncId() };
    await writeMetadata(metadataPath, metadata);
  }
  const ok = await verifyMasterPassword(
    masterPassword,
    metadata.masterPassword,
  );
  if (!ok) {
    throw new Error("Incorrect master password");
  }
  const aesKey = await deriveAesKey(masterPassword, metadata.kdfSalt);
  return { masterPassword, aesKey, metadata, metadataPath };
}

export async function getDbPassword(
  session: Session,
  key: string,
): Promise<string | null> {
  const cipher = session.metadata.dbPasswords[key];
  if (!cipher || !session.aesKey) return null;
  return decryptSecret(session.aesKey, cipher);
}

export async function setDbPassword(
  session: Session,
  key: string,
  password: string,
): Promise<void> {
  if (!session.aesKey) {
    throw new Error("AES key missing; master password required");
  }
  session.metadata.dbPasswords[key] = await encryptSecret(
    session.aesKey,
    password,
  );
  await writeMetadata(session.metadataPath, session.metadata);
}

/** Change master: re-hash + re-AES all dbPasswords with new key. Returns new session. */
export async function changeMasterPassword(
  session: Session,
  newMaster: string,
): Promise<Session> {
  if (!session.aesKey) {
    throw new Error("Current session has no AES key");
  }
  const plain: Record<string, string> = {};
  for (const [k, cipher] of Object.entries(session.metadata.dbPasswords)) {
    plain[k] = await decryptSecret(session.aesKey, cipher);
  }

  const kdfSalt = newKdfSalt();
  const newKey = await deriveAesKey(newMaster, kdfSalt);
  const dbPasswords: Record<string, string> = {};
  for (const [k, pw] of Object.entries(plain)) {
    dbPasswords[k] = await encryptSecret(newKey, pw);
  }

  const encId = session.metadata.encId || newEncId();
  const metadata: Metadata = {
    masterPassword: await hashMasterPassword(newMaster),
    kdfSalt,
    dbPasswords,
    encId,
  };
  await writeMetadata(session.metadataPath, metadata);
  return {
    masterPassword: newMaster,
    aesKey: newKey,
    metadata,
    metadataPath: session.metadataPath,
  };
}

