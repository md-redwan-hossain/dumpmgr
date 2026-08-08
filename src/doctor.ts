import { access, constants, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import { needsMaster } from "./config.ts";
import { ensureDumpsRootWritable, resolveDumpsRoot } from "./dumps.ts";
import { assertDockerAvailable } from "./docker.ts";
import { dbPathForConfig, vaultHasMaster } from "./metadata.ts";
import { getEncId, openVault } from "./vault.ts";

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
  const probe = `${parent}/.dumpmgr-doctor-${Date.now()}`;
  try {
    await writeFile(probe, "ok");
  } finally {
    await rm(probe, { force: true });
  }
}

async function checkVaultDb(vaultPath: string): Promise<{
  ok: boolean;
  message: string;
  hint?: string;
}> {
  if (!(await Bun.file(vaultPath).exists())) {
    return {
      ok: false,
      message: `vault database not found at ${vaultPath}`,
      hint: "run `dumpmgr config init`",
    };
  }
  return { ok: true, message: `vault database OK (${vaultPath})` };
}

export async function runDoctor(
  config: Config,
  configPath: string,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

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

  const vaultPath = dbPathForConfig(configPath);
  const vaultCheck = await checkVaultDb(vaultPath);
  checks.push({ name: "vault-db", ...vaultCheck });

  if (config.s3Options) {
    checks.push({
      name: "s3-config",
      ok: true,
      message: `S3 configured: ${config.s3Options.endpoint}/${config.s3Options.bucketName}`,
      hint: "S3 credentials are checked by `dumpmgr s3 upload` or `dumpmgr s3 download` after master unlock.",
    });
  }

  if (vaultCheck.ok) {
    try {
      const db = await openVault(configPath);
      try {
        if (needsMaster(config)) {
          const has = await vaultHasMaster(configPath);
          checks.push({
            name: "kdf-salt",
            ok: has,
            message: has ? "kdfSalt present" : "kdfSalt missing",
            hint: has ? undefined : "run `dumpmgr config init` to set a master password",
          });
          checks.push({
            name: "master-hash",
            ok: has,
            message: has ? "master password hash present" : "master password hash missing",
            hint: has ? undefined : "run `dumpmgr config init` to set a master password",
          });
        }
        if (config.encryptedDump) {
          const id = getEncId(db);
          checks.push({
            name: "enc-id",
            ok: Boolean(id),
            message: id ? `encId present (${id})` : "encId missing",
            hint: id ? undefined : "encId is generated on next successful master unlock",
          });
        }
      } finally {
        db.close();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checks.push({
        name: "vault-body",
        ok: false,
        message: `cannot open vault: ${message}`,
      });
    }
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}
