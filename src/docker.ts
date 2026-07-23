import { cpus } from "node:os";
import { resolve } from "node:path";
import type { Database } from "./config.ts";

export type ResolvedDb = Database & { password: string };

/** Balanced custom-format compression (same default as Databasus). */
export const DUMP_COMPRESS = "zstd:5";

/** Rewrite loopback hosts so Docker Desktop on Windows/macOS can reach the host. */
export function dockerHost(host: string): string {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") {
    return "host.docker.internal";
  }
  return host;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Parallel jobs for seekable pg_restore archives (capped like Databasus). */
export function restoreJobs(): number {
  return Math.min(cpus().length, 8);
}

async function runDocker(
  args: string[],
  opts?: { env?: Record<string, string>; quiet?: boolean },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["docker", ...args], {
    env: { ...process.env, ...opts?.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (!opts?.quiet) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }

  return { exitCode, stdout, stderr };
}

async function runDockerInteractive(
  args: string[],
  env?: Record<string, string>,
): Promise<number> {
  const proc = Bun.spawn(["docker", ...args], {
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  return await proc.exited;
}

function baseRunArgs(image: string, password: string, volume?: string): string[] {
  const args = ["run", "--rm", "-e", `PGPASSWORD=${password}`];
  if (volume) {
    args.push("-v", volume);
  }
  args.push(image);
  return args;
}

function pgDumpArgList(db: ResolvedDb): string[] {
  const host = dockerHost(db.host);
  return [
    "pg_dump",
    "-h",
    host,
    "-p",
    String(db.port),
    "-U",
    db.user,
    "-d",
    db.dbname,
    "-Fc",
    `--compress=${DUMP_COMPRESS}`,
  ];
}

function pgRestoreArgList(db: ResolvedDb, input: string, parallel: boolean): string[] {
  const host = dockerHost(db.host);
  const args = [
    "pg_restore",
    "-h",
    host,
    "-p",
    String(db.port),
    "-U",
    db.user,
    "-d",
    db.dbname,
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-acl",
  ];
  // Parallel restore needs a seekable archive; stdin "-" cannot use -j.
  if (parallel) {
    args.push("-j", String(restoreJobs()));
  }
  args.push(input);
  return args;
}

/** Verify host/port/user/password. Source connects to dbname; dest uses maintenance DB `postgres`. */
export async function verifyConnection(
  image: string,
  role: "source" | "destination",
  label: string,
  db: ResolvedDb,
  opts?: { database?: string },
): Promise<void> {
  const host = dockerHost(db.host);
  const database = opts?.database ?? db.dbname;
  const args = [
    ...baseRunArgs(image, db.password),
    "psql",
    "-h",
    host,
    "-p",
    String(db.port),
    "-U",
    db.user,
    "-d",
    database,
    "-tAc",
    "SELECT 1",
  ];

  const { exitCode, stdout, stderr } = await runDocker(args, { quiet: true });
  if (exitCode !== 0 || stdout.trim() !== "1") {
    throw new Error(
      `Cannot connect to ${role} "${label}" (${db.user}@${db.host}:${db.port}/${database}):\n${stderr || stdout}`,
    );
  }
}

export async function databaseExists(
  image: string,
  db: ResolvedDb,
): Promise<boolean> {
  const host = dockerHost(db.host);
  const sql = `SELECT 1 FROM pg_database WHERE datname='${db.dbname.replaceAll("'", "''")}'`;
  const args = [
    ...baseRunArgs(image, db.password),
    "psql",
    "-h",
    host,
    "-p",
    String(db.port),
    "-U",
    db.user,
    "-d",
    "postgres",
    "-tAc",
    sql,
  ];

  const { exitCode, stdout, stderr } = await runDocker(args, { quiet: true });
  if (exitCode !== 0) {
    throw new Error(
      `Failed to check if database exists on ${db.host}:${db.port}:\n${stderr || stdout}`,
    );
  }
  return stdout.trim() === "1";
}

export async function createDatabase(
  image: string,
  db: ResolvedDb,
): Promise<void> {
  const host = dockerHost(db.host);
  const sql = `CREATE DATABASE ${quoteIdent(db.dbname)}`;
  const args = [
    ...baseRunArgs(image, db.password),
    "psql",
    "-h",
    host,
    "-p",
    String(db.port),
    "-U",
    db.user,
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ];

  const exitCode = await runDockerInteractive(args);
  if (exitCode !== 0) {
    throw new Error(`Failed to create database "${db.dbname}"`);
  }
}

/** File-based dump for `--keep-dump` (Docker volume mount). */
export async function pgDump(
  image: string,
  db: ResolvedDb,
  workdir: string,
  dumpFileName: string,
): Promise<void> {
  const absWorkdir = resolve(workdir);
  const volume = `${absWorkdir}:/backup`;

  const args = [
    ...baseRunArgs(image, db.password, volume),
    ...pgDumpArgList(db),
    "-f",
    `/backup/${dumpFileName}`,
  ];

  const exitCode = await runDockerInteractive(args);
  if (exitCode !== 0) {
    throw new Error(`pg_dump failed for ${db.user}@${db.host}/${db.dbname}`);
  }
}

/** File-based restore with parallel jobs (seekable archive). */
export async function pgRestore(
  image: string,
  db: ResolvedDb,
  workdir: string,
  dumpFileName: string,
): Promise<void> {
  const absWorkdir = resolve(workdir);
  const volume = `${absWorkdir}:/backup`;

  const args = [
    ...baseRunArgs(image, db.password, volume),
    ...pgRestoreArgList(db, `/backup/${dumpFileName}`, true),
  ];

  const exitCode = await runDockerInteractive(args);
  if (exitCode !== 0) {
    throw new Error(`pg_restore failed for ${db.user}@${db.host}/${db.dbname}`);
  }
}

function shSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Stream pg_dump into pg_restore inside one container (Linux pipe).
 * Avoids host→Docker stdin piping, which breaks on Windows Docker Desktop
 * (`pg_restore: could not open input file "-"`).
 * Parallel `-j` is omitted: pg_restore cannot seek a pipe.
 */
export async function pgDumpRestorePipe(
  image: string,
  source: ResolvedDb,
  dest: ResolvedDb,
): Promise<void> {
  const sourceHost = dockerHost(source.host);
  const destHost = dockerHost(dest.host);

  const script = [
    "set -o pipefail;",
    `PGPASSWORD="$PGPASSWORD_SRC" pg_dump`,
    `-h ${shSingleQuote(sourceHost)}`,
    `-p ${source.port}`,
    `-U ${shSingleQuote(source.user)}`,
    `-d ${shSingleQuote(source.dbname)}`,
    `-Fc --compress=${DUMP_COMPRESS}`,
    "|",
    `PGPASSWORD="$PGPASSWORD_DEST" pg_restore`,
    `-h ${shSingleQuote(destHost)}`,
    `-p ${dest.port}`,
    `-U ${shSingleQuote(dest.user)}`,
    `-d ${shSingleQuote(dest.dbname)}`,
    "--clean --if-exists --no-owner --no-acl",
  ].join(" ");

  const args = [
    "run",
    "--rm",
    "-e",
    `PGPASSWORD_SRC=${source.password}`,
    "-e",
    `PGPASSWORD_DEST=${dest.password}`,
    image,
    "bash",
    "-c",
    script,
  ];

  const exitCode = await runDockerInteractive(args);
  if (exitCode !== 0) {
    throw new Error(
      `Streamed dump/restore failed: ${source.user}@${source.host}/${source.dbname} → ${dest.user}@${dest.host}/${dest.dbname}`,
    );
  }
}
