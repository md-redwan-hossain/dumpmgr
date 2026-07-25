import { dirname, join } from "node:path";
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
});

export type Metadata = z.infer<typeof MetadataSchema>;

export type Session = {
  masterPassword: string | null;
  aesKey: CryptoKey | null;
  metadata: Metadata;
  metadataPath: string;
};

export function metadataPathForConfig(configPath: string): string {
  return join(dirname(configPath), "metadata.json");
}

export async function loadMetadata(path: string): Promise<Metadata> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { masterPassword: null, kdfSalt: null, dbPasswords: {} };
  }
  const raw = await file.json();
  const parsed = MetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid metadata.json: ${path}`);
  }
  return parsed.data;
}

export async function writeMetadata(
  path: string,
  meta: Metadata,
): Promise<void> {
  await Bun.write(path, `${JSON.stringify(meta, null, 2)}\n`);
}

export async function createMetadataWithMaster(
  path: string,
  masterPassword: string,
): Promise<Metadata> {
  const meta: Metadata = {
    masterPassword: await hashMasterPassword(masterPassword),
    kdfSalt: newKdfSalt(),
    dbPasswords: {},
  };
  await writeMetadata(path, meta);
  return meta;
}

export async function emptyMetadata(path: string): Promise<Metadata> {
  const meta: Metadata = {
    masterPassword: null,
    kdfSalt: null,
    dbPasswords: {},
  };
  await writeMetadata(path, meta);
  return meta;
}

export async function unlockSession(
  metadataPath: string,
  masterPassword: string,
): Promise<Session> {
  const metadata = await loadMetadata(metadataPath);
  if (!metadata.masterPassword || !metadata.kdfSalt) {
    throw new Error("metadata.json has no master password; run init again");
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

  const metadata: Metadata = {
    masterPassword: await hashMasterPassword(newMaster),
    kdfSalt,
    dbPasswords,
  };
  await writeMetadata(session.metadataPath, metadata);
  return {
    masterPassword: newMaster,
    aesKey: newKey,
    metadata,
    metadataPath: session.metadataPath,
  };
}
