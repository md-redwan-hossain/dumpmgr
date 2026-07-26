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
  const probe = join(dumpsRoot, `.dumpmgr-write-test-${Date.now()}`);
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

/** UTC timestamp: yyyy-MM-dd_HH-mm-ss */
export function dumpTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}`;
}

export function dbDumpDir(
  dumpsRoot: string,
  engine: Engine,
  itemKey: string,
): string {
  return join(dumpsRoot, engine, ...itemKey.split(":"));
}

export function dumpFileKey(itemKey: string): string {
  return itemKey.replaceAll(":", "__");
}

const ENC_ID_RE = /_enc_([A-F0-9]+)(\.(dump|sql))$/i;

export function newDumpFileName(
  engine: Engine,
  itemKey: string,
): string {
  return `${engine}_${dumpFileKey(itemKey)}_${dumpTimestamp()}${dumpExtension(engine)}`;
}

export function isEncryptedDumpName(fileName: string): boolean {
  return (
    fileName.endsWith(".enc") ||
    ENC_ID_RE.test(fileName) ||
    /_encrypted\.(dump|sql)$/i.test(fileName)
  );
}

export function dumpEncIdFromName(fileName: string): string | null {
  const m = fileName.match(ENC_ID_RE);
  return m ? m[1]!.toUpperCase() : null;
}

/** Derive a plaintext temp basename from an encrypted dump filename. */
export function plainTempNameFromEncrypted(fileName: string): string {
  if (fileName.endsWith(".enc")) return fileName.replace(/\.enc$/, "");
  return fileName
    .replace(ENC_ID_RE, "$2")
    .replace(/_encrypted(\.(dump|sql))$/i, "$1");
}

export function encryptedPathFromPlain(path: string, encId: string): string {
  if (isEncryptedDumpName(basename(path))) return path;
  return path.replace(/(\.(dump|sql))$/i, `_enc_${encId}$1`);
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

export type DumpBrowserEntry =
  | { kind: "dir"; name: string }
  | { kind: "file"; name: string };

export async function listDumpBrowserEntries(
  dir: string,
  encryptedOnly: boolean,
): Promise<DumpBrowserEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const dirs: DumpBrowserEntry[] = [];
  const files: DumpBrowserEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = await stat(full);
    if (st.isDirectory()) {
      dirs.push({ kind: "dir", name });
      continue;
    }
    const isDump =
      name.endsWith(".dump") ||
      name.endsWith(".sql") ||
      name.endsWith(".dump.enc") ||
      name.endsWith(".sql.enc");
    if (!isDump) continue;
    const ok = encryptedOnly
      ? isEncryptedDumpName(name)
      : !isEncryptedDumpName(name);
    if (ok) files.push({ kind: "file", name });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => b.name.localeCompare(a.name));
  return [...dirs, ...files];
}

export async function encryptDumpFile(
  path: string,
  key: CryptoKey,
  encId: string,
): Promise<string> {
  const raw = new Uint8Array(await Bun.file(path).arrayBuffer());
  const enc = await encryptBytes(key, raw);
  const outPath = encryptedPathFromPlain(path, encId);
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

export async function hasEncryptedDumpsWithEncId(
  dumpsRoot: string,
  encId: string,
): Promise<boolean> {
  const want = encId.toUpperCase();
  const walk = async (dir: string): Promise<boolean> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return false;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const st = await stat(full);
      if (st.isDirectory()) {
        if (await walk(full)) return true;
        continue;
      }
      if (dumpEncIdFromName(name) === want) return true;
    }
    return false;
  };
  return walk(dumpsRoot);
}

export async function reencryptAllDumps(
  dumpsRoot: string,
  oldKey: CryptoKey,
  newKey: CryptoKey,
  encId?: string,
): Promise<number> {
  let count = 0;
  const want = encId?.toUpperCase();
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
      if (want) {
        const id = dumpEncIdFromName(name);
        if (id !== want) continue;
      }
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

export async function deleteEncryptedDumpsWithEncId(
  dumpsRoot: string,
  encId: string,
): Promise<number> {
  let count = 0;
  const want = encId.toUpperCase();
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
      if (dumpEncIdFromName(name) === want) {
        await rm(full, { force: true });
        count++;
      }
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
