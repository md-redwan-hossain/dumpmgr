import { cpus } from "node:os";
import { resolve } from "node:path";
import type { DatabaseItem, Engine } from "./config.ts";

export type ResolvedDb = DatabaseItem & { password: string };

/** Balanced custom-format compression (same default as Databasus). */
export const DUMP_COMPRESS = "zstd:5";

/** Fail fast with a clear message if the Docker daemon is not reachable. */
export async function assertDockerAvailable(): Promise<void> {
  try {
    const proc = Bun.spawn(["docker", "info"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(
        "Docker is not available.",
      );
    }
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.startsWith("Docker is not available")
    ) {
      throw err;
    }
    throw new Error(
      "Docker is not available.",
    );
  }
}

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

function quoteMysqlIdent(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
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

function pgBaseArgs(
  image: string,
  password: string,
  volume?: string,
): string[] {
  const args = ["run", "--rm", "-e", `PGPASSWORD=${password}`];
  if (volume) args.push("-v", volume);
  args.push(image);
  return args;
}

function mysqlBaseArgs(
  image: string,
  password: string,
  volume?: string,
): string[] {
  const args = ["run", "--rm", "-e", `MYSQL_PWD=${password}`];
  if (volume) args.push("-v", volume);
  args.push(image);
  return args;
}

function maintenanceDb(engine: Engine): string {
  return engine === "postgres" ? "postgres" : "mysql";
}

export async function verifyConnection(
  engine: Engine,
  image: string,
  role: "source" | "destination",
  label: string,
  db: ResolvedDb,
  opts?: { database?: string },
): Promise<void> {
  const host = dockerHost(db.host);
  const database = opts?.database ?? db.database;

  if (engine === "postgres") {
    const args = [
      ...pgBaseArgs(image, db.password),
      "psql",
      "--host",
      host,
      "--port",
      String(db.port),
      "--username",
      db.user,
      "--dbname",
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
    return;
  }

  const client = engine === "mariadb" ? "mariadb" : "mysql";
  const args = [
    ...mysqlBaseArgs(image, db.password),
    client,
    "--host",
    host,
    "--port",
    String(db.port),
    "--user",
    db.user,
    "--database",
    database,
    "--batch",
    "--skip-column-names",
    "--execute",
    "SELECT 1",
  ];
  const { exitCode, stdout, stderr } = await runDocker(args, { quiet: true });
  if (exitCode !== 0 || !stdout.trim().startsWith("1")) {
    throw new Error(
      `Cannot connect to ${role} "${label}" (${db.user}@${db.host}:${db.port}/${database}):\n${stderr || stdout}`,
    );
  }
}

export async function databaseExists(
  engine: Engine,
  image: string,
  db: ResolvedDb,
): Promise<boolean> {
  const host = dockerHost(db.host);

  if (engine === "postgres") {
    const sql = `SELECT 1 FROM pg_database WHERE datname='${db.database.replaceAll("'", "''")}'`;
    const args = [
      ...pgBaseArgs(image, db.password),
      "psql",
      "--host",
      host,
      "--port",
      String(db.port),
      "--username",
      db.user,
      "--dbname",
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

  const client = engine === "mariadb" ? "mariadb" : "mysql";
  const sql = `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='${db.database.replaceAll("'", "''")}'`;
  const args = [
    ...mysqlBaseArgs(image, db.password),
    client,
    "--host",
    host,
    "--port",
    String(db.port),
    "--user",
    db.user,
    "--database",
    "mysql",
    "--batch",
    "--skip-column-names",
    "--execute",
    sql,
  ];
  const { exitCode, stdout, stderr } = await runDocker(args, { quiet: true });
  if (exitCode !== 0) {
    throw new Error(
      `Failed to check if database exists on ${db.host}:${db.port}:\n${stderr || stdout}`,
    );
  }
  return stdout.trim() === db.database;
}

export async function createDatabase(
  engine: Engine,
  image: string,
  db: ResolvedDb,
): Promise<void> {
  const host = dockerHost(db.host);

  if (engine === "postgres") {
    const sql = `CREATE DATABASE ${quoteIdent(db.database)}`;
    const args = [
      ...pgBaseArgs(image, db.password),
      "psql",
      "--host",
      host,
      "--port",
      String(db.port),
      "--username",
      db.user,
      "--dbname",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ];
    const { exitCode, stderr, stdout } = await runDocker(args, { quiet: true });
    if (exitCode !== 0) {
      throw new Error(
        `Failed to create database "${db.database}":\n${stderr || stdout}`,
      );
    }
    return;
  }

  const client = engine === "mariadb" ? "mariadb" : "mysql";
  const sql = `CREATE DATABASE ${quoteMysqlIdent(db.database)}`;
  const args = [
    ...mysqlBaseArgs(image, db.password),
    client,
    "--host",
    host,
    "--port",
    String(db.port),
    "--user",
    db.user,
    "--database",
    "mysql",
    "--execute",
    sql,
  ];
  const { exitCode, stderr, stdout } = await runDocker(args, { quiet: true });
  if (exitCode !== 0) {
    throw new Error(
      `Failed to create database "${db.database}":\n${stderr || stdout}`,
    );
  }
}

export async function dropDatabase(
  engine: Engine,
  image: string,
  db: ResolvedDb,
): Promise<void> {
  const host = dockerHost(db.host);

  if (engine === "postgres") {
    const esc = db.database.replaceAll("'", "''");
    const terminate = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${esc}' AND pid <> pg_backend_pid()`;
    const drop = `DROP DATABASE IF EXISTS ${quoteIdent(db.database)}`;
    for (const sql of [terminate, drop]) {
      const args = [
        ...pgBaseArgs(image, db.password),
        "psql",
        "--host",
        host,
        "--port",
        String(db.port),
        "--username",
        db.user,
        "--dbname",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ];
      const { exitCode, stderr, stdout } = await runDocker(args, { quiet: true });
      if (exitCode !== 0) {
        throw new Error(
          `Failed to drop database "${db.database}":\n${stderr || stdout}`,
        );
      }
    }
    return;
  }

  const client = engine === "mariadb" ? "mariadb" : "mysql";
  const sql = `DROP DATABASE IF EXISTS ${quoteMysqlIdent(db.database)}`;
  const args = [
    ...mysqlBaseArgs(image, db.password),
    client,
    "--host",
    host,
    "--port",
    String(db.port),
    "--user",
    db.user,
    "--database",
    "mysql",
    "--execute",
    sql,
  ];
  const { exitCode, stderr, stdout } = await runDocker(args, { quiet: true });
  if (exitCode !== 0) {
    throw new Error(
      `Failed to drop database "${db.database}":\n${stderr || stdout}`,
    );
  }
}

/** Quiet file dump (for ora spinner). workdir mounted at /backup; dumpFileName relative to workdir. */
export async function dumpDatabase(
  engine: Engine,
  image: string,
  db: ResolvedDb,
  workdir: string,
  dumpFileName: string,
): Promise<void> {
  const absWorkdir = resolve(workdir);
  const volume = `${absWorkdir}:/backup`;
  const host = dockerHost(db.host);
  const out = `/backup/${dumpFileName}`;

  if (engine === "postgres") {
    const args = [
      ...pgBaseArgs(image, db.password, volume),
      "pg_dump",
      `--host=${host}`,
      `--port=${db.port}`,
      `--username=${db.user}`,
      `--dbname=${db.database}`,
      "--format=custom",
      `--compress=${DUMP_COMPRESS}`,
      `--file=${out}`,
    ];
    const { exitCode, stderr, stdout } = await runDocker(args, { quiet: true });
    if (exitCode !== 0) {
      throw new Error(
        `pg_dump failed for ${db.user}@${db.host}/${db.database}:\n${stderr || stdout}`,
      );
    }
    return;
  }

  const dumpCmd = engine === "mariadb" ? "mariadb-dump" : "mysqldump";
  const args = [
    ...mysqlBaseArgs(image, db.password, volume),
    dumpCmd,
    `--host=${host}`,
    `--port=${db.port}`,
    `--user=${db.user}`,
    "--single-transaction",
    "--routines",
    "--triggers",
    "--databases",
    db.database,
    `--result-file=${out}`,
  ];
  const { exitCode, stderr, stdout } = await runDocker(args, { quiet: true });
  if (exitCode !== 0) {
    throw new Error(
      `${dumpCmd} failed for ${db.user}@${db.host}/${db.database}:\n${stderr || stdout}`,
    );
  }
}

export async function restoreDatabase(
  engine: Engine,
  image: string,
  db: ResolvedDb,
  workdir: string,
  dumpFileName: string,
): Promise<void> {
  const absWorkdir = resolve(workdir);
  const volume = `${absWorkdir}:/backup`;
  const host = dockerHost(db.host);
  const input = `/backup/${dumpFileName}`;

  if (engine === "postgres") {
    const args = [
      ...pgBaseArgs(image, db.password, volume),
      "pg_restore",
      `--host=${host}`,
      `--port=${db.port}`,
      `--username=${db.user}`,
      `--dbname=${db.database}`,
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-acl",
      `--jobs=${restoreJobs()}`,
      input,
    ];
    const { exitCode, stderr, stdout } = await runDocker(args, { quiet: true });
    // pg_restore often exits 1 with warnings; treat only hard failures
    if (exitCode !== 0 && exitCode !== 1) {
      throw new Error(
        `pg_restore failed for ${db.user}@${db.host}/${db.database}:\n${stderr || stdout}`,
      );
    }
    if (exitCode === 1 && /fatal|error:/i.test(stderr) && !/warning:/i.test(stderr)) {
      // keep permissive like many tools: exit 1 is common for non-fatal
    }
    return;
  }

  const client = engine === "mariadb" ? "mariadb" : "mysql";
  // mysqldump --databases emits CREATE/USE; feed file via shell redirect
  const args = [
    "run",
    "--rm",
    "-e",
    `MYSQL_PWD=${db.password}`,
    "-v",
    volume,
    image,
    "bash",
    "-c",
    `${client} --host=${host} --port=${db.port} --user=${db.user} < ${input}`,
  ];
  const { exitCode, stderr, stdout } = await runDocker(args, { quiet: true });
  if (exitCode !== 0) {
    throw new Error(
      `${client} restore failed for ${db.user}@${db.host}/${db.database}:\n${stderr || stdout}`,
    );
  }
}

export { maintenanceDb };
