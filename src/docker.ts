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

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteMysqlLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

/** Parallel jobs for seekable pg_restore archives (capped like Databasus). */
export function restoreJobs(): number {
  return Math.min(cpus().length, 8);
}

let dockerDebug = false;
let dockerDebugLog: (msg: string) => void = () => {};

export function setDockerDebug(
  enabled: boolean,
  log: (msg: string) => void = console.error,
): void {
  dockerDebug = enabled;
  dockerDebugLog = enabled ? log : () => {};
}

function formatDockerCmd(args: string[]): string {
  const parts: string[] = ["docker"];
  for (const a of args) {
    let shown = a;
    if (a.startsWith("PGPASSWORD=") || a.startsWith("MYSQL_PWD=")) {
      shown = `${a.slice(0, a.indexOf("=") + 1)}***`;
    }
    parts.push(/\s/.test(shown) ? JSON.stringify(shown) : shown);
  }
  return parts.join(" ");
}

async function runDocker(
  args: string[],
  opts?: { env?: Record<string, string>; quiet?: boolean },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (dockerDebug) {
    dockerDebugLog(`[debug] ${formatDockerCmd(args)}`);
  }
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
  opts?: { connectDatabase?: string },
): Promise<boolean> {
  const host = dockerHost(db.host);
  const loginDb = opts?.connectDatabase ?? maintenanceDb(engine);

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
      loginDb,
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
    loginDb,
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
  opts?: { connectDatabase?: string },
): Promise<void> {
  const host = dockerHost(db.host);
  const loginDb = opts?.connectDatabase ?? maintenanceDb(engine);

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
      loginDb,
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
    loginDb,
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
  opts?: { connectDatabase?: string },
): Promise<void> {
  const host = dockerHost(db.host);
  const loginDb = opts?.connectDatabase ?? maintenanceDb(engine);

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
        loginDb,
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
    loginDb,
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

/** Create/alter login role and grant access to a database (via parent connection). */
export async function ensureDatabaseLogin(
  engine: Engine,
  image: string,
  parentDb: ResolvedDb,
  opts: {
    user: string;
    password: string;
    database: string;
    connectDatabase?: string;
  },
): Promise<void> {
  const host = dockerHost(parentDb.host);
  const loginDb = opts.connectDatabase ?? maintenanceDb(engine);

  if (engine === "postgres") {
    const role = quoteIdent(opts.user);
    const roleLit = quoteLiteral(opts.user);
    const pwLit = quoteLiteral(opts.password);
    const dbIdent = quoteIdent(opts.database);
    const ensureRole = [
      `DO $dumpmgr$ BEGIN`,
      `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleLit}) THEN`,
      `    CREATE ROLE ${role} LOGIN PASSWORD ${pwLit};`,
      `  ELSE`,
      `    ALTER ROLE ${role} PASSWORD ${pwLit};`,
      `  END IF;`,
      `END $dumpmgr$`,
    ].join(" ");
    const grantDb = `GRANT ALL PRIVILEGES ON DATABASE ${dbIdent} TO ${role}`;
    const grantSchema = `GRANT ALL ON SCHEMA public TO ${role}`;

    for (const [sql, dbname] of [
      [ensureRole, loginDb],
      [grantDb, loginDb],
      [grantSchema, opts.database],
    ] as const) {
      const args = [
        ...pgBaseArgs(image, parentDb.password),
        "psql",
        "--host",
        host,
        "--port",
        String(parentDb.port),
        "--username",
        parentDb.user,
        "--dbname",
        dbname,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ];
      const { exitCode, stderr, stdout } = await runDocker(args, {
        quiet: true,
      });
      if (exitCode !== 0) {
        throw new Error(
          `Failed to ensure login "${opts.user}" on "${opts.database}":\n${stderr || stdout}`,
        );
      }
    }
    return;
  }

  const client = engine === "mariadb" ? "mariadb" : "mysql";
  const userLit = quoteMysqlLiteral(opts.user);
  const pwLit = quoteMysqlLiteral(opts.password);
  const dbIdent = quoteMysqlIdent(opts.database);
  const sql = [
    `CREATE USER IF NOT EXISTS ${userLit}@'%' IDENTIFIED BY ${pwLit}`,
    `ALTER USER ${userLit}@'%' IDENTIFIED BY ${pwLit}`,
    `GRANT ALL PRIVILEGES ON ${dbIdent}.* TO ${userLit}@'%'`,
    `FLUSH PRIVILEGES`,
  ].join("; ");
  const args = [
    ...mysqlBaseArgs(image, parentDb.password),
    client,
    "--host",
    host,
    "--port",
    String(parentDb.port),
    "--user",
    parentDb.user,
    "--database",
    loginDb,
    "--execute",
    sql,
  ];
  const { exitCode, stderr, stdout } = await runDocker(args, { quiet: true });
  if (exitCode !== 0) {
    throw new Error(
      `Failed to ensure login "${opts.user}" on "${opts.database}":\n${stderr || stdout}`,
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
  opts?: { clean?: boolean },
): Promise<{ warnings?: string }> {
  const absWorkdir = resolve(workdir);
  const volume = `${absWorkdir}:/backup`;
  const host = dockerHost(db.host);
  const input = `/backup/${dumpFileName}`;
  const clean = opts?.clean ?? false;

  if (engine === "postgres") {
    const args = [
      ...pgBaseArgs(image, db.password, volume),
      "pg_restore",
      `--host=${host}`,
      `--port=${db.port}`,
      `--username=${db.user}`,
      `--dbname=${db.database}`,
      ...(clean ? ["--clean", "--if-exists"] : []),
      "--no-owner",
      "--no-acl",
      `--jobs=${restoreJobs()}`,
      input,
    ];
    const { exitCode, stderr, stdout } = await runDocker(args, { quiet: true });
    const out = (stderr || stdout).trim();
    // pg_restore: 0=ok; 1=non-fatal (warnings / ignored errors); >1 or FATAL=hard fail
    if (exitCode === 0) return {};
    if (exitCode > 1 || /FATAL:/i.test(out)) {
      throw new Error(
        `pg_restore failed for ${db.user}@${db.host}/${db.database}:\n${out}`,
      );
    }
    if (exitCode === 1) {
      const hasError = /pg_restore:\s*error:|ERROR:/i.test(out);
      const errorsIgnored = /errors ignored on restore/i.test(out);
      if (hasError && !errorsIgnored) {
        throw new Error(
          `pg_restore failed for ${db.user}@${db.host}/${db.database}:\n${out}`,
        );
      }
      if (hasError && errorsIgnored && out) {
        return { warnings: out };
      }
      return {};
    }
    throw new Error(
      `pg_restore failed for ${db.user}@${db.host}/${db.database}:\n${out}`,
    );
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
  return {};
}

export { maintenanceDb };
