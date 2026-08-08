import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { Cron } from "croner";
import {
  configImage,
  configItems,
  dbKey,
  loadConfigAsync,
  needsMaster,
  type AutonomousSchedule,
  type Config,
  type DatabaseItem,
} from "./config.ts";
import {
  assertDockerAvailable,
  dumpDatabase,
  setDockerDebug,
  verifyConnection,
  type ResolvedDb,
} from "./docker.ts";
import {
  dbDumpDir,
  encryptDumpFile,
  ensureDumpsRootWritable,
  formatBytes,
  formatDuration,
  newDumpFileName,
  resolveDumpsRoot,
} from "./dumps.ts";
import {
  encId,
  getDbPassword,
  getS3SecretKey,
  unlockSession,
  type Session,
} from "./metadata.ts";
import {
  createS3Client,
  uploadToS3,
  verifyS3Bucket,
} from "./s3.ts";

const MASTER_PASSWORD_ENV = "DUMPMGR_MASTER_PASSWORD";
const S3_SECRET_KEY_ENV = "DUMPMGR_S3_SECRET_KEY";

function log(message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${message}`);
}

function logError(message: string): void {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ERROR ${message}`);
}

function masterPasswordFromEnv(): string | null {
  const value = process.env[MASTER_PASSWORD_ENV]?.trim();
  return value || null;
}

function s3SecretKeyFromEnv(): string | null {
  const value = process.env[S3_SECRET_KEY_ENV]?.trim();
  return value || null;
}

async function unlockAutonomousSession(
  config: Config,
  configPath: string,
): Promise<Session | null> {
  if (!needsMaster(config)) return null;
  const master = masterPasswordFromEnv();
  if (!master) {
    throw new Error(
      `${MASTER_PASSWORD_ENV} is required for autonomous mode when rememberPassword, encryptedDump, or s3Options are enabled`,
    );
  }
  return await unlockSession(configPath, master);
}

async function resolveS3SecretKey(session: Session | null): Promise<string | null> {
  if (session) {
    const stored = await getS3SecretKey(session);
    if (stored) return stored;
  }
  return s3SecretKeyFromEnv();
}

async function resolveItemPassword(
  config: Config,
  session: Session | null,
  item: DatabaseItem,
): Promise<string> {
  if (config.rememberPassword && session) {
    const saved = await getDbPassword(session, dbKey(item.key));
    if (saved) return saved;
  }
  throw new Error(
    `No saved password for "${item.key}". Run interactive dumpmgr once to store credentials in metadata.`,
  );
}

function itemsForSchedule(config: Config, schedule: AutonomousSchedule): DatabaseItem[] {
  const all = configItems(config);
  if (!schedule.items || schedule.items.length === 0) return all;

  const byKey = new Map(all.map((item) => [item.key, item]));
  const selected: DatabaseItem[] = [];
  for (const key of schedule.items) {
    const item = byKey.get(key);
    if (!item) {
      throw new Error(`autonomous schedule references unknown item "${key}"`);
    }
    selected.push(item);
  }
  return selected;
}

export async function runScheduledDumpForItem(opts: {
  config: Config;
  session: Session | null;
  item: DatabaseItem;
  uploadToS3: boolean;
  s3SecretKey?: string | null;
}): Promise<string> {
  const { config, session, item } = opts;
  const image = configImage(config);
  const dumpsRoot = resolveDumpsRoot(config.dumpDirectory);
  await ensureDumpsRootWritable(dumpsRoot);

  const password = await resolveItemPassword(config, session, item);
  const db: ResolvedDb = { ...item, password };

  log(`Verifying connection to ${item.key}…`);
  await verifyConnection(image, "source", item.key, db);

  const dir = dbDumpDir(dumpsRoot, item.key);
  await mkdir(dir, { recursive: true });
  const plainName = newDumpFileName(item.key);
  const dumpPath = join(dir, plainName);

  log(`Dumping ${item.key} → ${plainName}`);
  const t0 = performance.now();
  await dumpDatabase(image, db, dir, plainName);
  const elapsedMs = performance.now() - t0;
  const size = Bun.file(dumpPath).size;
  log(
    `Dump complete for ${item.key} in ${formatDuration(elapsedMs)} (${formatBytes(size)})`,
  );

  let finalPath = dumpPath;
  if (config.encryptedDump) {
    if (!session?.aesKey) {
      throw new Error("AES key required for encrypted dumps");
    }
    const eid = encId(session);
    if (!eid) throw new Error("encId missing from vault");
    log(`Encrypting dump for ${item.key}…`);
    finalPath = await encryptDumpFile(dumpPath, session.aesKey, eid);
    log(`Encrypted ${basename(finalPath)} (${formatBytes(Bun.file(finalPath).size)})`);
  }

  if (opts.uploadToS3 && config.s3Options) {
    const secretKey = opts.s3SecretKey ?? await resolveS3SecretKey(session);
    if (!secretKey) {
      throw new Error(
        `S3 upload requested but no secret key in metadata or ${S3_SECRET_KEY_ENV}`,
      );
    }
    const client = createS3Client(config.s3Options, secretKey);
    await verifyS3Bucket(config.s3Options, secretKey);
    const key = await uploadToS3(client, dumpsRoot, finalPath);
    log(`Uploaded ${key} to ${config.s3Options.bucketName}`);
  }

  return finalPath;
}

async function runSchedule(
  config: Config,
  configPath: string,
  schedule: AutonomousSchedule,
  session: Session | null,
  s3SecretKey: string | null,
): Promise<void> {
  const label = schedule.cron;
  log(`Running schedule ${label}`);
  const items = itemsForSchedule(config, schedule);
  let s3Key = s3SecretKey;
  if (schedule.uploadToS3 && config.s3Options && !s3Key) {
    s3Key = await resolveS3SecretKey(session);
  }

  for (const item of items) {
    try {
      await runScheduledDumpForItem({
        config,
        session,
        item,
        uploadToS3: schedule.uploadToS3,
        s3SecretKey: s3Key,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Failed to dump ${item.key}: ${message}`);
    }
  }
}

function validateCronExpression(expression: string): void {
  try {
    new Cron(expression, { paused: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid cron expression "${expression}": ${detail}`);
  }
}

export async function runAutonomous(opts: {
  configPath: string;
  debug?: boolean;
  once?: boolean;
}): Promise<void> {
  if (opts.debug) {
    setDockerDebug(true, (msg) => log(`[debug] ${msg}`));
  }

  const configPath = opts.configPath;
  const config = await loadConfigAsync(configPath);
  const autonomous = config.autonomous;
  if (!autonomous) {
    throw new Error(
      "autonomous section missing in config.jsonc. Add schedules to enable autonomous backups.",
    );
  }
  if (autonomous.schedules.length === 0) {
    throw new Error("autonomous.schedules must contain at least one entry");
  }

  for (const schedule of autonomous.schedules) {
    validateCronExpression(schedule.cron);
  }

  await assertDockerAvailable();
  const session = await unlockAutonomousSession(config, configPath);
  const s3SecretKey = config.s3Options ? await resolveS3SecretKey(session) : null;

  log(
    `Autonomous mode started (${autonomous.schedules.length} schedule(s), once=${opts.once ?? false})`,
  );

  if (opts.once) {
    for (const schedule of autonomous.schedules) {
      await runSchedule(config, configPath, schedule, session, s3SecretKey);
    }
    log("Autonomous one-shot run complete");
    return;
  }

  const jobs: Cron[] = [];
  for (const schedule of autonomous.schedules) {
    const job = new Cron(schedule.cron, async () => {
      await runSchedule(config, configPath, schedule, session, s3SecretKey);
    });
    jobs.push(job);
    log(`Registered cron "${schedule.cron}" (next: ${job.nextRun()?.toISOString() ?? "unknown"})`);
  }

  const shutdown = () => {
    log("Stopping autonomous scheduler…");
    for (const job of jobs) job.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("Scheduler running; waiting for cron triggers");
}
