import type { Session as VaultSession } from "./vault.ts";
import {
  createVaultWithMaster,
  dbPathForConfig,
  deleteDbPassword as vaultDeleteDbPassword,
  getDbPassword as vaultGetDbPassword,
  getEncId,
  getS3SecretKey as vaultGetS3SecretKey,
  hasMaster,
  legacyPathForConfig,
  newEncId,
  openVault,
  setDbPassword as vaultSetDbPassword,
  setS3SecretKey as vaultSetS3SecretKey,
  unlockSession as vaultUnlockSession,
  changeMasterPassword as vaultChangeMasterPassword,
} from "./vault.ts";

export type Session = VaultSession;

/** @deprecated Legacy DBSM magic bytes; vault uses SQLite. */
export const METADATA_MAGIC = new TextEncoder().encode("DBSM");
export const METADATA_VERSION = 1;

export { newEncId, dbPathForConfig, legacyPathForConfig };

/** Path to vault.db next to config.jsonc. */
export function metadataPathForConfig(configPath: string): string {
  return dbPathForConfig(configPath);
}

export async function unlockSession(
  configPath: string,
  masterPassword: string,
): Promise<Session> {
  return vaultUnlockSession(configPath, masterPassword);
}

export async function createMetadataWithMaster(
  configPath: string,
  masterPassword: string,
): Promise<Session> {
  return createVaultWithMaster(configPath, masterPassword);
}

export async function emptyMetadata(configPath: string): Promise<void> {
  const db = await openVault(configPath);
  db.close();
}

export async function getDbPassword(session: Session, key: string): Promise<string | null> {
  return vaultGetDbPassword(session, key);
}

export async function setDbPassword(
  session: Session,
  key: string,
  password: string,
): Promise<void> {
  return vaultSetDbPassword(session, key, password);
}

export async function getS3SecretKey(session: Session): Promise<string | null> {
  return vaultGetS3SecretKey(session);
}

export async function setS3SecretKey(session: Session, secretKey: string): Promise<void> {
  return vaultSetS3SecretKey(session, secretKey);
}

export async function deleteDbPassword(session: Session, key: string): Promise<boolean> {
  return vaultDeleteDbPassword(session, key);
}

export async function changeMasterPassword(
  session: Session,
  newMaster: string,
): Promise<Session> {
  return vaultChangeMasterPassword(session, newMaster);
}

export function encId(session: Session): string {
  return getEncId(session.db);
}

export async function vaultHasMaster(configPath: string): Promise<boolean> {
  const db = await openVault(configPath);
  try {
    return hasMaster(db);
  } finally {
    db.close();
  }
}
