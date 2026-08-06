import { describe, expect, test } from "bun:test";
import {
  decryptBytes,
  decryptSecret,
  encryptBytes,
  encryptSecret,
} from "../src/crypto.ts";
import {
  deleteDbPassword,
  emptyMetadata,
  getDbPassword,
  getS3SecretKey,
  loadMetadata,
  setDbPassword,
  setS3SecretKey,
  type Session,
  writeMetadata,
} from "../src/metadata.ts";
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

describe("metadata", () => {
  test("persists encrypted DB and S3 secrets", async () => {
    await withTempDir(async (directory) => {
      const path = `${directory}/metadata`;
      const session: Session = {
        masterPassword: "test-master",
        aesKey: await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
        metadata: {
          masterPassword: null,
          kdfSalt: null,
          dbPasswords: {},
          encId: "A1B2",
          s3SecretKey: null,
        },
        metadataPath: path,
      };
      await writeMetadata(path, session.metadata);
      await setDbPassword(session, "postgres:prod", "db-secret");
      await setS3SecretKey(session, "s3-secret");

      expect(await getDbPassword(session, "postgres:prod")).toBe("db-secret");
      expect(await getS3SecretKey(session)).toBe("s3-secret");
      expect((await Bun.file(path).arrayBuffer()).byteLength).toBeGreaterThan(5);

      const reloaded: Session = {
        ...session,
        metadata: await loadMetadata(path),
      };
      expect(await getDbPassword(reloaded, "postgres:prod")).toBe("db-secret");
      expect(await getS3SecretKey(reloaded)).toBe("s3-secret");
      expect(await deleteDbPassword(reloaded, "postgres:prod")).toBe(true);
      expect(await deleteDbPassword(reloaded, "postgres:missing")).toBe(false);
      expect(await getDbPassword(reloaded, "postgres:prod")).toBeNull();
    });
  });

  test("creates empty metadata and migrates legacy JSON metadata", async () => {
    await withTempDir(async (directory) => {
      const emptyPath = `${directory}/empty`;
      await emptyMetadata(emptyPath);
      expect((await loadMetadata(emptyPath)).dbPasswords).toEqual({});

      const legacyPath = `${directory}/metadata.json`;
      const binaryPath = `${directory}/metadata`;
      await Bun.write(
        legacyPath,
        JSON.stringify({
          masterPassword: null,
          kdfSalt: null,
          dbPasswords: {},
          encId: null,
        }),
      );
      const migrated = await loadMetadata(binaryPath);
      expect(migrated.encId).toMatch(/^[A-F0-9]{32}$/);
      expect(await Bun.file(legacyPath).exists()).toBe(false);
      expect((await Bun.file(binaryPath).arrayBuffer()).byteLength).toBeGreaterThan(5);
    });
  });
});
