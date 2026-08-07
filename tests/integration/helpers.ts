import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "comment-json";
import type { Config } from "../../src/config.ts";
import { assertDockerAvailable } from "../../src/docker.ts";
import type { ResolvedDb } from "../../src/docker.ts";

export const INTEGRATION_POSTGRES_IMAGE =
  process.env.DUMPMGR_IT_IMAGE ?? "postgres:18";

export type PostgresFixture = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  image: string;
  containerId: string;
};

type DockerRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

async function runDocker(args: string[]): Promise<DockerRunResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await assertDockerAvailable();
    return true;
  } catch {
    return false;
  }
}

async function waitForPostgres(
  pg: PostgresFixture,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await runDocker([
      "exec",
      pg.containerId,
      "pg_isready",
      "-U",
      pg.user,
      "-d",
      pg.database,
    ]);
    if (ready.exitCode === 0) return;
    await Bun.sleep(500);
  }
  throw new Error("Postgres container did not become ready in time");
}

function parseMappedPort(dockerPortOutput: string): number {
  const line = dockerPortOutput.trim().split("\n")[0]?.trim();
  const port = Number(line?.split(":").pop());
  if (!port || Number.isNaN(port)) {
    throw new Error(`Could not parse mapped Postgres port: ${dockerPortOutput}`);
  }
  return port;
}

let postgresImageReady: Promise<void> | null = null;

async function ensurePostgresImage(): Promise<void> {
  if (!postgresImageReady) {
    postgresImageReady = (async () => {
      const inspect = await runDocker([
        "image",
        "inspect",
        INTEGRATION_POSTGRES_IMAGE,
      ]);
      if (inspect.exitCode === 0) return;
      const pull = await runDocker(["pull", INTEGRATION_POSTGRES_IMAGE]);
      if (pull.exitCode !== 0) {
        throw new Error(
          `Failed to pull ${INTEGRATION_POSTGRES_IMAGE}: ${pull.stderr}`,
        );
      }
    })();
  }
  await postgresImageReady;
}

/** Start an ephemeral Postgres container; always stopped in `finally`. */
export async function withPostgres<T>(
  fn: (pg: PostgresFixture) => Promise<T>,
): Promise<T> {
  await ensurePostgresImage();
  const name = `dumpmgr-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = "test";
  const password = "test";
  const database = "app";

  const started = await runDocker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-e",
    `POSTGRES_USER=${user}`,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    `POSTGRES_DB=${database}`,
    "-p",
    "127.0.0.1::5432",
    INTEGRATION_POSTGRES_IMAGE,
  ]);
  if (started.exitCode !== 0) {
    throw new Error(`Failed to start Postgres container: ${started.stderr}`);
  }

  const containerId = started.stdout.trim();
  try {
    const mapped = await runDocker(["port", containerId, "5432/tcp"]);
    if (mapped.exitCode !== 0) {
      throw new Error(`Failed to read mapped port: ${mapped.stderr}`);
    }

    const pg: PostgresFixture = {
      host: "127.0.0.1",
      port: parseMappedPort(mapped.stdout),
      user,
      password,
      database,
      image: INTEGRATION_POSTGRES_IMAGE,
      containerId,
    };

    await waitForPostgres(pg);
    return await fn(pg);
  } finally {
    await runDocker(["stop", containerId]);
  }
}

export function toResolvedDb(
  pg: PostgresFixture,
  database = pg.database,
  key = "it",
): ResolvedDb {
  return {
    key,
    host: pg.host,
    port: pg.port,
    user: pg.user,
    password: pg.password,
    database,
    nested: false,
  };
}

/** Run SQL inside the Postgres container (for seeding and assertions). */
export async function execSql(
  pg: PostgresFixture,
  sql: string,
  database = pg.database,
): Promise<string> {
  const proc = Bun.spawn(
    [
      "docker",
      "exec",
      pg.containerId,
      "psql",
      "-U",
      pg.user,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-tAc",
      sql,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`SQL failed:\n${sql}\n${stderr || stdout}`);
  }
  return stdout.trim();
}

export async function withTempDir<T>(
  fn: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "dumpmgr-it-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function sampleConfig(
  overrides?: Partial<Config> & {
    items?: Config["items"];
  },
): Config {
  return {
    rememberPassword: false,
    encryptedDump: false,
    dumpDirectory: ".",
    image: INTEGRATION_POSTGRES_IMAGE,
    items: {
      prod: {
        host: "127.0.0.1",
        port: 5432,
        user: "test",
        database: "app",
        readonly: false,
      },
    },
    ...overrides,
  };
}

export function integrationConfig(
  pg: PostgresFixture,
  overrides?: Partial<Config>,
): Config {
  return {
    rememberPassword: false,
    encryptedDump: false,
    dumpDirectory: ".",
    image: pg.image,
    items: {
      prod: {
        host: pg.host,
        port: pg.port,
        user: pg.user,
        database: pg.database,
        readonly: false,
      },
    },
    ...overrides,
  };
}

export async function writeConfigFile(
  directory: string,
  config: Config,
): Promise<string> {
  const path = join(directory, "config.jsonc");
  await writeFile(path, `${stringify(config, null, 2)}\n`);
  return path;
}

export async function runDumpmgrCli(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    cwd: opts?.cwd ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
