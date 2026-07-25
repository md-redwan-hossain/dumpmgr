import { access, constants, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Engine } from "./config.ts";
import { decryptBytes, encryptBytes } from "./crypto.ts";

export function resolveDumpsRoot(dumpDirectory: string): string {
  const abs = resolve(dumpDirectory);
  if (basename(abs).toLowerCase() === "dumps") return abs;
  return join(abs, "dumps");
}

export async function ensureDumpsRootWritable(dumpsRoot: string): Promise<void> {
  await mkdir(dumpsRoot, { recursive: true });
  try {
    await access(dumpsRoot, constants.W_OK);
  } catch {
    throw new Error(`Dumps directory is not writable: ${dumpsRoot}`);
  }
  const probe = join(dumpsRoot, `.dbsync-write-test-${Date.now()}`);
  try {
    await writeFile(probe, "ok");
    await rm(probe);
  } catch {
    throw new Error(`Dumps directory is not writable: ${dumpsRoot}`);
  }
}

export function dumpExtension(engine: Engine): string {
  return engine === "postgres" ? ".dump" : ".sql";
}

/** Local timestamp: yyyy-MM-dd_HH-mm-ss */
export function dumpTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export function dbDumpDir(
  dumpsRoot: string,
  engine: Engine,
  itemKey: string,
): string {
  return join(dumpsRoot, engine, itemKey);
}

export function newDumpFileName(
  engine: Engine,
  itemKey: string,
  encrypted = false,
): string {
  const stamp = dumpTimestamp();
  const mid = encrypted ? `${stamp}_encrypted` : stamp;
  return `${engine}_${itemKey}_${mid}${dumpExtension(engine)}`;
}

export function isEncryptedDumpName(fileName: string): boolean {
  return (
    fileName.endsWith(".enc") ||
    /_encrypted\.(dump|sql)$/i.test(fileName)
  );
}

/** Derive a plaintext temp basename from an encrypted dump filename. */
export function plainTempNameFromEncrypted(fileName: string): string {
  if (fileName.endsWith(".enc")) return fileName.replace(/\.enc$/, "");
  return fileName.replace(/_encrypted(\.(dump|sql))$/i, "$1");
}

export function encryptedPathFromPlain(path: string): string {
  if (isEncryptedDumpName(basename(path))) return path;
  return path.replace(/(\.(dump|sql))$/i, "_encrypted$1");
}

export async function listDumpFiles(
  dir: string,
  encryptedOnly: boolean,
): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter((f) => {
        const isDump =
          f.endsWith(".dump") ||
          f.endsWith(".sql") ||
          f.endsWith(".dump.enc") ||
          f.endsWith(".sql.enc");
        if (!isDump) return false;
        return encryptedOnly
          ? isEncryptedDumpName(f)
          : !isEncryptedDumpName(f);
      })
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export async function encryptDumpFile(
  path: string,
  key: CryptoKey,
): Promise<string> {
  const raw = new Uint8Array(await Bun.file(path).arrayBuffer());
  const enc = await encryptBytes(key, raw);
  const outPath = encryptedPathFromPlain(path);
  await Bun.write(outPath, enc);
  if (outPath !== path) await rm(path);
  return outPath;
}

export async function decryptDumpToTemp(
  encPath: string,
  key: CryptoKey,
  tempPath: string,
): Promise<void> {
  const data = new Uint8Array(await Bun.file(encPath).arrayBuffer());
  const plain = await decryptBytes(key, data);
  await Bun.write(tempPath, plain);
}

export async function reencryptAllDumps(
  dumpsRoot: string,
  oldKey: CryptoKey,
  newKey: CryptoKey,
): Promise<number> {
  let count = 0;
  const walk = async (dir: string) => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const st = await stat(full);
      if (st.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!isEncryptedDumpName(name)) continue;
      const data = new Uint8Array(await Bun.file(full).arrayBuffer());
      const plain = await decryptBytes(oldKey, data);
      const enc = await encryptBytes(newKey, plain);
      await Bun.write(full, enc);
      count++;
    }
  };
  await walk(dumpsRoot);
  return count;
}

export async function deleteAllDumps(dumpsRoot: string): Promise<void> {
  await rm(dumpsRoot, { recursive: true, force: true });
  await mkdir(dumpsRoot, { recursive: true });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
