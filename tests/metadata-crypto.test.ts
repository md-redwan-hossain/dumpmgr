import { describe, expect, test } from "bun:test";
import {
  decryptBytes,
  decryptSecret,
  encryptBytes,
  encryptSecret,
} from "../src/crypto.ts";
import {
  changeMasterPassword,
  createMetadataWithMaster,
  deleteDbPassword,
  emptyMetadata,
  getDbPassword,
  getS3SecretKey,
  setDbPassword,
  setS3SecretKey,
  unlockSession,
} from "../src/metadata.ts";
import { rm } from "node:fs/promises";
import { dbPathForConfig } from "../src/vault.ts";
import { withTempDir } from "./helpers.ts";

describe("crypto", () => {
  test("round trips strings and bytes and rejects tampering", async () => {
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const secret = await encryptSecret(key, "database password");
    expect(await decryptSecret(key, secret)).toBe("database password");

    const bytes = await encryptBytes(key, new TextEncoder().encode("dump"));
    expect(new TextDecoder().decode(await decryptBytes(key, bytes))).toBe("dump");
    bytes[bytes.length - 1]! ^= 1;
    await expect(decryptBytes(key, bytes)).rejects.toThrow();
  });
});

describe("vault metadata", () => {
  test("persists encrypted DB and S3 secrets", async () => {
    await withTempDir(async (directory) => {
      const configPath = `${directory}/config.jsonc`;
      await Bun.write(configPath, "{}");
      const session = await createMetadataWithMaster(configPath, "test-master");
      await setDbPassword(session, "postgres:prod", "db-secret");
      await setS3SecretKey(session, "s3-secret");

      expect(await getDbPassword(session, "postgres:prod")).toBe("db-secret");
      expect(await getS3SecretKey(session)).toBe("s3-secret");
      expect((await Bun.file(dbPathForConfig(configPath)).arrayBuffer()).byteLength).toBeGreaterThan(
        100,
      );

      const reloaded = await unlockSession(configPath, "test-master");
      expect(await getDbPassword(reloaded, "postgres:prod")).toBe("db-secret");
      expect(await getS3SecretKey(reloaded)).toBe("s3-secret");
      expect(await deleteDbPassword(reloaded, "postgres:prod")).toBe(true);
      expect(await deleteDbPassword(reloaded, "postgres:missing")).toBe(false);
      expect(await getDbPassword(reloaded, "postgres:prod")).toBeNull();
      reloaded.db.close();
      session.db.close();
    });
  });

  test("changeMasterPassword re-encrypts DB and S3 secrets", async () => {
    await withTempDir(async (directory) => {
      const configPath = `${directory}/config.jsonc`;
      await Bun.write(configPath, "{}");
      const master = "old-master";
      await createMetadataWithMaster(configPath, master);
      const session = await unlockSession(configPath, master);
      await setDbPassword(session, "postgres:prod", "db-secret");
      await setS3SecretKey(session, "s3-secret");
      const oldS3Cipher = (
        session.db.query("SELECT s3_secret_key FROM vault_meta WHERE id = 1").get() as {
          s3_secret_key: string;
        }
      ).s3_secret_key;

      await changeMasterPassword(session, "new-master");
      const reloaded = await unlockSession(configPath, "new-master");

      expect(await getDbPassword(reloaded, "postgres:prod")).toBe("db-secret");
      expect(await getS3SecretKey(reloaded)).toBe("s3-secret");
      const newS3Cipher = (
        reloaded.db.query("SELECT s3_secret_key FROM vault_meta WHERE id = 1").get() as {
          s3_secret_key: string;
        }
      ).s3_secret_key;
      expect(newS3Cipher).not.toBe(oldS3Cipher);
      reloaded.db.close();
      session.db.close();
    });
  });

  test("creates empty vault and migrates legacy JSON metadata", async () => {
    await withTempDir(async (directory) => {
      const configPath = `${directory}/config.jsonc`;
      await emptyMetadata(configPath);
      const vaultPath = dbPathForConfig(configPath);
      expect(await Bun.file(vaultPath).exists()).toBe(true);

      const legacyPath = `${directory}/metadata.json`;
      await Bun.write(
        legacyPath,
        JSON.stringify({
          masterPassword: null,
          kdfSalt: null,
          dbPasswords: {},
          encId: null,
        }),
      );
      await Bun.write(configPath, "{}");
      await rm(vaultPath);
      const { openVault, getEncId } = await import("../src/vault.ts");
      const db = await openVault(configPath);
      const id = getEncId(db);
      expect(id).toMatch(/^[A-F0-9]{32}$/);
      expect(await Bun.file(`${legacyPath}.bak`).exists()).toBe(true);
      db.close();
    });
  });
});
