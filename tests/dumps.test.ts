import { mkdir } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import {
  decryptDumpToTemp,
  dbDumpDir,
  dumpEncIdFromName,
  dumpFileKey,
  dumpTimestamp,
  encryptedPathFromPlain,
  encryptDumpFile,
  formatBytes,
  formatDuration,
  isEncryptedDumpName,
  listDumpBrowserEntries,
  listDumpFiles,
  plainTempNameFromEncrypted,
  resolveDumpsRoot,
} from "../src/dumps.ts";
import { withTempDir } from "./helpers.ts";

describe("dumps", () => {
  test("builds dump paths and UTC names", () => {
    expect(resolveDumpsRoot("/tmp/backups")).toBe("/tmp/backups/dumps");
    expect(resolveDumpsRoot("/tmp/dumps")).toBe("/tmp/dumps");
    expect(dbDumpDir("/tmp/dumps", "parent:child")).toBe(
      "/tmp/dumps/parent/child",
    );
    expect(dumpFileKey("parent:child")).toBe("parent__child");
    expect(dumpTimestamp(new Date("2026-08-06T01:02:03Z"))).toBe(
      "2026-08-06_01-02-03",
    );
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatDuration(1250)).toBe("1.3s");
  });

  test("recognizes encrypted filenames and recovers their plain names", () => {
    const name = "parent__child_2026-08-06_01-02-03_enc_A1B2.dump";
    expect(isEncryptedDumpName(name)).toBe(true);
    expect(dumpEncIdFromName(name)).toBe("A1B2");
    expect(plainTempNameFromEncrypted(name)).toBe(
      "parent__child_2026-08-06_01-02-03.dump",
    );
    expect(encryptedPathFromPlain(`/tmp/plain.dump`, "A1B2")).toBe(
      "/tmp/plain_enc_A1B2.dump",
    );
    expect(isEncryptedDumpName("plain.dump")).toBe(false);
  });

  test("lists only relevant dump files in stable order", async () => {
    await withTempDir(async (directory) => {
      await Bun.write(`${directory}/old.dump`, "old");
      await Bun.write(`${directory}/new_enc_A1.dump`, "new");
      await Bun.write(`${directory}/notes.txt`, "ignore");
      await mkdir(`${directory}/folder`);
      await Bun.write(`${directory}/folder/file`, "ignore");

      expect(await listDumpFiles(directory, false)).toEqual(["old.dump"]);
      expect(await listDumpFiles(directory, true)).toEqual(["new_enc_A1.dump"]);
      expect(await listDumpBrowserEntries(directory, false)).toEqual([
        { kind: "dir", name: "folder" },
        { kind: "file", name: "old.dump" },
      ]);
    });
  });

  test("encrypts a dump and decrypts it to a temporary path", async () => {
    await withTempDir(async (directory) => {
      const plainPath = `${directory}/sample.dump`;
      const tempPath = `${directory}/restored.dump`;
      await Bun.write(plainPath, "dump payload");
      const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      const encryptedPath = await encryptDumpFile(plainPath, key, "A1B2");

      expect(encryptedPath).toBe(`${directory}/sample_enc_A1B2.dump`);
      expect(await Bun.file(plainPath).exists()).toBe(false);
      await decryptDumpToTemp(encryptedPath, key, tempPath);
      expect(await Bun.file(tempPath).text()).toBe("dump payload");
    });
  });
});
