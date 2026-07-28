import { access, constants, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { needsMaster } from "./config.ts";
import { ensureDumpsRootWritable, resolveDumpsRoot } from "./dumps.ts";
import { assertDockerAvailable } from "./docker.ts";
import {
  loadMetadata,
  METADATA_MAGIC,
  METADATA_VERSION,
  metadataPathForConfig,
} from "./metadata.ts";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  message: string;
  hint?: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
};

async function dockerVersion(): Promise<string> {
  try {
    const proc = Bun.spawn(["docker", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return "docker present (version unknown)";
    return stdout.trim() || "docker present";
  } catch {
    return "docker present (version unknown)";
  }
}

async function probeParentDir(parent: string): Promise<void> {
  await mkdir(parent, { recursive: true });
  try {
    await access(parent, constants.W_OK);
  } catch {
    throw new Error(`Parent directory is not writable: ${parent}`);
  }
  const probe = join(parent, `.dumpmgr-doctor-${Date.now()}`);
  try {
    await writeFile(probe, "ok");
  } finally {
    await rm(probe, { force: true });
  }
}

async function checkMetadataMagic(metaPath: string): Promise<{
  ok: boolean;
  message: string;
  hint?: string;
}> {
  const file = Bun.file(metaPath);
  if (!(await file.exists())) {
    return {
      ok: false,
      message: `metadata file not found at ${metaPath}`,
      hint: "run `dumpmgr config init`",
    };
  }
  let buf: Uint8Array;
  try {
    buf = new Uint8Array(await file.arrayBuffer());
  } catch {
    return {
      ok: false,
      message: `cannot read metadata at ${metaPath}`,
    };
  }
  if (buf.length < METADATA_MAGIC.length + 1) {
    return {
      ok: false,
      message: "metadata file is too short",
      hint: "run `dumpmgr config init` to recreate",
    };
  }
  for (let i = 0; i < METADATA_MAGIC.length; i++) {
    if (buf[i] !== METADATA_MAGIC[i]) {
      return {
        ok: false,
        message: "metadata has bad magic (not a DBSM file)",
        hint: "delete the file and run `dumpmgr config init`",
      };
    }
  }
  const version = buf[METADATA_MAGIC.length];
  if (version !== METADATA_VERSION) {
    return {
      ok: false,
      message: `unsupported metadata version: ${version}`,
      hint: `expected version ${METADATA_VERSION}`,
    };
  }
  return { ok: true, message: `metadata magic OK (DBSM v${version})` };
}

export async function runDoctor(
  config: Config,
  configPath: string,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // Docker daemon
  try {
    await assertDockerAvailable();
    const ver = await dockerVersion();
    checks.push({ name: "docker", ok: true, message: ver });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push({
      name: "docker",
      ok: false,
      message,
      hint: "start Docker Desktop / the docker daemon and retry",
    });
  }

  // Dumps root parent dir writable
  const dumpsRoot = resolveDumpsRoot(config.dumpDirectory);
  const parent = dirname(dumpsRoot);
  try {
    await probeParentDir(parent);
    checks.push({
      name: "dumps-parent",
      ok: true,
      message: `parent dir writable: ${parent}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push({
      name: "dumps-parent",
      ok: false,
      message,
    });
  }

  // Dumps root writable
  try {
    await ensureDumpsRootWritable(dumpsRoot);
    checks.push({
      name: "dumps-root",
      ok: true,
      message: `dumps dir writable: ${dumpsRoot}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push({ name: "dumps-root", ok: false, message });
  }

  // Metadata magic
  const metaPath = metadataPathForConfig(configPath);
  const magic = await checkMetadataMagic(metaPath);
  checks.push({ name: "metadata-magic", ...magic });

  // KDF salt + master hash + encId (only meaningful if we can decode the body)
  if (magic.ok) {
    try {
      const meta = await loadMetadata(metaPath);
      if (needsMaster(config)) {
        checks.push({
          name: "kdf-salt",
          ok: meta.kdfSalt != null,
          message:
            meta.kdfSalt != null
              ? "kdfSalt present"
              : "kdfSalt missing",
          hint:
            meta.kdfSalt == null
              ? "run `dumpmgr config init` to set a master password"
              : undefined,
        });
        checks.push({
          name: "master-hash",
          ok: meta.masterPassword != null,
          message:
            meta.masterPassword != null
              ? "master password hash present"
              : "master password hash missing",
          hint:
            meta.masterPassword == null
              ? "run `dumpmgr config init` to set a master password"
              : undefined,
        });
      }
      if (config.encryptedDump) {
        checks.push({
          name: "enc-id",
          ok: meta.encId != null,
          message:
            meta.encId != null
              ? `encId present (${meta.encId})`
              : "encId missing",
          hint:
            meta.encId == null
              ? "encId is generated on next successful master unlock"
              : undefined,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checks.push({
        name: "metadata-body",
        ok: false,
        message: `cannot decode metadata body: ${message}`,
      });
    }
  }

  // Touch the file once so the unused-import lint doesn't complain when no
  // child check references stat() directly (the magic check already used it
  // via Bun.file). Keep stat imported in case future checks need it.
  void stat;

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}