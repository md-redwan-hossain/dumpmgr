#!/usr/bin/env bun
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Command } from "commander";
import * as p from "@clack/prompts";
import ora from "ora";
import {
  configExists,
  configImage,
  configItems,
  dbKey,
  DEFAULT_CONFIG_PATH,
  lintConfigFile,
  loadConfigAsync,
  needsMaster,
  type Config,
  type DatabaseItem,
  validateConfigFile,
} from "./config.ts";
import { runDoctor } from "./doctor.ts";
import {
  assertDockerAvailable,
  DUMP_COMPRESS,
  dumpDatabase,
  restoreDatabase,
  restoreJobs,
  setDockerDebug,
  verifyConnection,
  type ResolvedDb,
} from "./docker.ts";
import {
  dbDumpDir,
  deleteEncryptedDumpsWithEncId,
  decryptDumpToTemp,
  encryptDumpFile,
  ensureDumpsRootWritable,
  formatBytes,
  formatDuration,
  hasEncryptedDumpsWithEncId,
  isEncryptedDumpName,
  newDumpFileName,
  plainTempNameFromEncrypted,
  reencryptAllDumps,
  resolveDumpsRoot,
} from "./dumps.ts";
import { runInit } from "./init.ts";
import {
  changeMasterPassword,
  dbPathForConfig,
  deleteDbPassword,
  encId,
  getDbPassword,
  getS3SecretKey,
  setDbPassword,
  setS3SecretKey,
  unlockSession,
  type Session,
} from "./metadata.ts";
import { recordDump, recordRestoreOp, recordSyncAudit } from "./record.ts";
import {
  Action,
  getDumpByPath,
  listAudit,
  listDumps,
  listRestoreHistory,
  listSecretRotations,
  listSecrets,
  openVault,
  recordAudit,
  scanDumpsRoot,
  sha256File,
  Status,
  vaultStatus,
} from "./vault.ts";
import {
  browseDumpFile,
  confirmOrYes,
  connectWithRetry,
  onCancel,
  promptPassword,
  requireItems,
  resolveDbPassword,
  resolveDatabaseItem,
  resolveDatabaseTree,
  selectMode,
  selectReplaceExistingObjects,
  selectS3Object,
} from "./prompt.ts";
import { prepareRestoreDestination } from "./restore-dest.ts";
import {
  createS3Client,
  downloadFromS3,
  listS3Objects,
  uploadToS3,
  verifyS3Bucket,
} from "./s3.ts";
import { runAutonomous } from "./autonomous.ts";

type CliMode = "dump" | "restore" | "dump-restore";
type S3Action = "upload" | "download";

type GlobalOpts = {
  config: string;
  yes?: boolean;
  debug?: boolean;
  mode?: CliMode;
  source?: string;
  dest?: string;
  dump?: string;
};

async function unlockOrNull(config: Config, configPath: string): Promise<Session | null> {
  if (!needsMaster(config)) return null;
  for (;;) {
    const master = await promptPassword("master password");
    try {
      return await unlockSession(configPath, master);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(message);
      const again = await p.confirm({ message: "Try again?", initialValue: true });
      if (p.isCancel(again) || !again) onCancel();
    }
  }
}

async function requireS3Session(
  config: Config,
  configPath: string,
): Promise<{ session: Session; secretAccessKey: string }> {
  if (!config.s3Options) {
    throw new Error("S3 is not configured. Add s3Options to config.jsonc.");
  }
  const session = await unlockOrNull(config, configPath);
  if (!session) throw new Error("Master password session required for S3");
  let secretAccessKey = await getS3SecretKey(session);
  if (!secretAccessKey) {
    secretAccessKey = await promptPassword("S3 secret access key");
    await setS3SecretKey(session, secretAccessKey);
    p.log.success("S3 secret access key encrypted in metadata");
  }
  return { session, secretAccessKey };
}

async function runS3Action(
  action: S3Action,
  config: Config,
  configPath: string,
  yes = false,
): Promise<void> {
  if (!config.s3Options) {
    throw new Error("S3 is not configured. Add s3Options to config.jsonc.");
  }
  const { secretAccessKey } = await requireS3Session(config, configPath);
  const client = createS3Client(config.s3Options, secretAccessKey);
  await verifyS3Bucket(config.s3Options, secretAccessKey);
  const dumpsRoot = resolveDumpsRoot(config.dumpDirectory);
  await ensureDumpsRootWritable(dumpsRoot);

  if (action === "upload") {
    const localPath = await browseDumpFile(dumpsRoot, config.encryptedDump);
    const key = await uploadToS3(client, dumpsRoot, localPath);
    p.log.success(`Uploaded ${key} to ${config.s3Options.bucketName}`);
    return;
  }

  const objects = await listS3Objects(config.s3Options, secretAccessKey);
  const key = await selectS3Object(objects);
  const localPath = resolveDumpsRoot(config.dumpDirectory);
  const target = join(localPath, key);
  if (await Bun.file(target).exists() && !yes) {
    const overwrite = await p.confirm({
      message: `${target} already exists. Overwrite?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) {
      p.log.warn("Download cancelled");
      return;
    }
  }
  const downloaded = await downloadFromS3(client, dumpsRoot, key);
  p.log.success(`Downloaded ${key} to ${downloaded}`);
}

async function resolveConnectedDb(opts: {
  config: Config;
  session: Session | null;
  item: DatabaseItem;
  role: "source" | "destination";
  maintenance?: boolean;
}): Promise<ResolvedDb> {
  const image = configImage(opts.config);
  const key = dbKey(opts.item.key);

  const password = await connectWithRetry({
    label: opts.item.key,
    getPassword: () =>
      resolveDbPassword({
        session: opts.session,
        rememberPassword: opts.config.rememberPassword,
        item: opts.item,
      }),
    setPassword: async (pw) => {
      if (opts.config.rememberPassword && opts.session) {
        await setDbPassword(opts.session, key, pw);
      }
    },
    connect: async (pw) => {
      const db: ResolvedDb = { ...opts.item, password: pw };
      await verifyConnection(
        image,
        opts.role,
        opts.item.key,
        db,
        opts.maintenance ? { database: "postgres" } : undefined,
      );
    },
  });

  return { ...opts.item, password };
}

async function runDumpWithSpinner(
  image: string,
  db: ResolvedDb,
  workdir: string,
  dumpFileName: string,
  label: string,
): Promise<{ elapsedMs: number; size: number; path: string }> {
  const dumpPath = join(workdir, dumpFileName);
  const spinner = ora({ text: `Dumping ${label}… 0.0s` }).start();
  const t0 = performance.now();
  const tick = setInterval(() => {
    spinner.text = `Dumping ${label}… ${formatDuration(performance.now() - t0)}`;
  }, 100);
  try {
    await dumpDatabase(image, db, workdir, dumpFileName);
  } finally {
    clearInterval(tick);
  }
  const elapsedMs = performance.now() - t0;
  const size = Bun.file(dumpPath).size;
  spinner.succeed(
    `Dump complete in ${formatDuration(elapsedMs)} (${formatBytes(size)})`,
  );
  return { elapsedMs, size, path: dumpPath };
}

async function runRestoreWithSpinner(
  image: string,
  db: ResolvedDb,
  workdir: string,
  dumpFileName: string,
  label: string,
  opts?: { clean?: boolean },
): Promise<number> {
  const jobsHint = ` (--jobs ${restoreJobs()})`;
  const spinner = ora({
    text: `Restoring ${label}${jobsHint}… 0.0s`,
  }).start();
  const t0 = performance.now();
  const tick = setInterval(() => {
    spinner.text = `Restoring ${label}${jobsHint}… ${formatDuration(performance.now() - t0)}`;
  }, 100);
  let warnings: string | undefined;
  try {
    const result = await restoreDatabase(image, db, workdir, dumpFileName, opts);
    warnings = result.warnings;
  } finally {
    clearInterval(tick);
  }
  const elapsedMs = performance.now() - t0;
  spinner.succeed(`Restore complete in ${formatDuration(elapsedMs)}`);
  if (warnings) {
    p.log.warn(`pg_restore reported ignored errors:\n${warnings}`);
  }
  return elapsedMs;
}

async function resolveRestoreClean(opts: {
  intoExisting: boolean;
  yes?: boolean;
}): Promise<boolean> {
  if (!opts.intoExisting) return false;
  return selectReplaceExistingObjects(opts.yes);
}

async function handleChangeMaster(
  config: Config,
  session: Session,
): Promise<Session> {
  const next = await promptPassword("new master password");
  const confirm = await promptPassword("confirm new master password");
  if (next !== confirm) {
    throw new Error("Master passwords do not match");
  }

  const oldKey = session.aesKey!;
  const prevEncId = encId(session);
  p.log.step("Re-encrypting saved database passwords…");
  const updated = await changeMasterPassword(session, next);
  p.log.success("Database passwords re-encrypted");

  const dumpsRoot = resolveDumpsRoot(config.dumpDirectory);
  if (prevEncId && (await hasEncryptedDumpsWithEncId(dumpsRoot, prevEncId))) {
    const action = await p.select({
      message: "What should happen to existing dumps?",
      options: [
        { value: "reencrypt", label: "Re-encrypt dumps" },
        { value: "delete", label: "Delete matching encrypted dumps" },
      ],
    });
    if (p.isCancel(action)) onCancel();

    if (action === "delete") {
      const n = await deleteEncryptedDumpsWithEncId(dumpsRoot, prevEncId);
      p.log.success(`Deleted ${n} encrypted dump(s)`);
    } else {
      await ensureDumpsRootWritable(dumpsRoot);
      const n = await reencryptAllDumps(dumpsRoot, oldKey, updated.aesKey, prevEncId);
      p.log.success(`Re-encrypted ${n} dump file(s)`);
    }
  }

  p.log.success("Master password changed");
  return updated;
}

async function runMode(
  mode: "dump-restore" | "dump" | "restore",
  opts: GlobalOpts,
  config: Config,
  session: Session | null,
): Promise<void> {
  const minItems = mode === "dump-restore" ? 2 : 1;
  requireItems(config, minItems);
  const items = configItems(config);
  const image = configImage(config);
  const dumpsRoot = resolveDumpsRoot(config.dumpDirectory);
  await ensureDumpsRootWritable(dumpsRoot);

  if (mode === "dump") {
    const sourceItem = await resolveDatabaseItem(
      items,
      opts.source,
      "Select database to dump",
    );
    const sourceDb = await resolveConnectedDb({
      config,
      session,
      item: sourceItem,
      role: "source",
    });

    const dir = dbDumpDir(dumpsRoot, sourceItem.key);
    await mkdir(dir, { recursive: true });
    const plainName = newDumpFileName(sourceItem.key);
    await runDumpWithSpinner(image, sourceDb, dir, plainName, sourceItem.key);

    let finalPath = join(dir, plainName);
    if (config.encryptedDump) {
      if (!session?.aesKey) throw new Error("AES key required for encrypted dumps");
      const eid = encId(session);
      if (!eid) throw new Error("encId missing from vault");
      p.log.step("Encrypting dump…");
      finalPath = await encryptDumpFile(finalPath, session.aesKey, eid);
      p.log.success(`Encrypted (${formatBytes(Bun.file(finalPath).size)})`);
    }

    await recordDump(session, dumpsRoot, finalPath, sourceItem.key);
    p.log.success(`Dump saved at ${finalPath}`);
    return;
  }

  if (mode === "restore") {
    const dumpPath = opts.dump
      ? resolve(opts.dump)
      : await browseDumpFile(dumpsRoot, config.encryptedDump);
    if (opts.dump && !(await Bun.file(dumpPath).exists())) {
      throw new Error(`Dump file not found: ${dumpPath}`);
    }
    const fileName = basename(dumpPath);
    const dir = dirname(dumpPath);

    const destItem = await resolveDatabaseTree(
      config,
      opts.dest,
      "Select destination database",
    );

    const prepared = await prepareRestoreDestination({
      config,
      session,
      destItem,
      image,
      yes: opts.yes,
      confirmMessage: `Restore "${fileName}" into "${destItem.key}"?`,
    });
    if ("cancelled" in prepared) {
      p.log.warn("Restore cancelled");
      return;
    }
    const { destDb, intoExisting } = prepared;

    const clean = await resolveRestoreClean({ intoExisting, yes: opts.yes });

    let restoreDir = dir;
    let restoreName = fileName;
    let tempPlain: string | null = null;

    if (isEncryptedDumpName(fileName)) {
      if (!session?.aesKey) throw new Error("AES key required to decrypt dump");
      tempPlain = join(
        dir,
        `.dumpmgr-decrypt-${Date.now()}_${plainTempNameFromEncrypted(fileName)}`,
      );
      p.log.step("Decrypting dump…");
      await decryptDumpToTemp(join(dir, fileName), session.aesKey, tempPlain);
      restoreDir = dir;
      restoreName = basename(tempPlain);
    }

    try {
      const elapsed = await runRestoreWithSpinner(image, destDb, restoreDir, restoreName, destItem.key, { clean });
      await recordRestoreOp(session, dumpsRoot, dumpPath, destItem.key, elapsed, clean, "", null);
    } finally {
      if (tempPlain) await rm(tempPlain, { force: true });
    }

    p.log.success(`Restored ${fileName} → ${destItem.key}`);
    return;
  }

  // dump-restore
  const sourceItem = await resolveDatabaseItem(
    items,
    opts.source,
    "Select source database",
  );
  const destItem = await resolveDatabaseTree(
    config,
    opts.dest,
    "Select destination database",
    sourceItem.key,
  );

  const sourceDb = await resolveConnectedDb({ config, session, item: sourceItem, role: "source" });

  const prepared = await prepareRestoreDestination({
    config,
    session,
    destItem,
    image,
    yes: opts.yes,
    confirmMessage: `Sync into "${destItem.key}"?`,
  });
  if ("cancelled" in prepared) {
    p.log.warn("Sync cancelled");
    return;
  }
  const { destDb, intoExisting: destIntoExisting } = prepared;

  p.note(
    [
      `Source:      ${sourceItem.key} → ${sourceDb.user}@${sourceDb.host}:${sourceDb.port}/${sourceDb.database}`,
      `Destination: ${destItem.key} → ${destDb.user}@${destDb.host}:${destDb.port}/${destDb.database}`,
      `Image:       ${image}`,
      `Compress:    ${DUMP_COMPRESS}`,
      `Dumps:       ${dumpsRoot}`,
      `Encrypted:   ${config.encryptedDump}`,
    ].join("\n"),
    "Sync plan",
  );

  const confirmed = await confirmOrYes(
    `Overwrite destination "${destItem.key}" with dump from "${sourceItem.key}"?`,
    opts.yes,
    false,
  );
  if (!confirmed) {
    p.log.warn("Sync cancelled");
    return;
  }

  const clean = await resolveRestoreClean({ intoExisting: destIntoExisting, yes: opts.yes });

  const dir = dbDumpDir(dumpsRoot, sourceItem.key);
  await mkdir(dir, { recursive: true });
  const plainName = newDumpFileName(sourceItem.key);
  await runDumpWithSpinner(image, sourceDb, dir, plainName, sourceItem.key);
  const restoreElapsed = await runRestoreWithSpinner(image, destDb, dir, plainName, destItem.key, { clean });

  let finalPath = join(dir, plainName);
  if (config.encryptedDump) {
    if (!session?.aesKey) throw new Error("AES key required for encrypted dumps");
    const eid = encId(session);
    if (!eid) throw new Error("encId missing from vault");
    p.log.step("Encrypting dump…");
    finalPath = await encryptDumpFile(finalPath, session.aesKey, eid);
    p.log.success(`Encrypted (${formatBytes(Bun.file(finalPath).size)})`);
  }

  await recordDump(session, dumpsRoot, finalPath, sourceItem.key);
  recordSyncAudit(session, sourceItem.key, destItem.key, basename(finalPath), null);
  await recordRestoreOp(session, dumpsRoot, join(dir, plainName), destItem.key, restoreElapsed, clean, "", null);

  p.log.info(`Dump kept at ${finalPath}`);
  p.log.success(`Synced ${sourceItem.key} → ${destItem.key}`);
}

async function runMain(opts: GlobalOpts): Promise<void> {
  if (opts.debug) {
    setDockerDebug(true, (msg) => p.log.info(msg));
  }

  p.intro(`dumpmgr — Dump Manager, docker based db dump & restore tool`);
  if (opts.debug) p.log.info("Debug mode on");

  const configPath = resolve(opts.config);
  if (!(await configExists(configPath))) {
    p.log.error(`Config file not found: ${configPath}`);
    const choice = await p.select({
      message: "Run config init to create config?",
      options: [
        { value: "fake", label: "Init with fake data" },
        { value: "empty", label: "Init with empty items" },
        { value: "abort", label: "Abort" },
      ],
    });
    if (p.isCancel(choice) || choice === "abort") onCancel();
    await runInit({
      config: configPath,
      withFakeData: choice === "fake",
    });
    process.exit(0);
  }

  const config = await loadConfigAsync(configPath);

  let session = await unlockOrNull(config, configPath);

  if (opts.mode) {
    try {
      await assertDockerAvailable();
      await runMode(opts.mode, opts, config, session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(message);
      process.exit(1);
    }
    return;
  }

  for (;;) {
    const mode = await selectMode(config);
    if (mode === "exit") {
      p.outro("Bye");
      return;
    }
    try {
      if (mode === "change-master") {
        if (!session) throw new Error("Master password session required");
        session = await handleChangeMaster(config, session);
        continue;
      }
      if (mode === "s3-upload" || mode === "s3-download") {
        await runS3Action(mode === "s3-upload" ? "upload" : "download", config, configPath);
        continue;
      }
      await assertDockerAvailable();
      await runMode(mode, opts, config, session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(message);
    }
  }
}

const MODE_DESCRIPTIONS: Record<CliMode, string> = {
  dump: "Take dump (write dump file only)",
  restore: "Restore from dump",
  "dump-restore": "Take dump and restore (copy source → destination)",
};

async function handleMain(opts: GlobalOpts): Promise<void> {
  try {
    await runMain(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(message);
    process.exit(1);
  }
}

async function handleS3Command(
  action: S3Action,
  opts: { config: string; yes?: boolean },
): Promise<void> {
  const configPath = resolve(opts.config);
  p.intro(`dumpmgr s3 ${action}`);
  if (!(await configExists(configPath))) {
    p.log.error(`Config file not found: ${configPath}`);
    process.exit(1);
  }
  try {
    const config = await loadConfigAsync(configPath);
    await runS3Action(action, config, configPath, opts.yes);
    p.outro("done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(message);
    process.exit(1);
  }
}

function addCommonOptions(cmd: Command): Command {
  // ponytail: commander treats a boolean 3rd arg as parseFn, so no `false` default
  return cmd
    .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
    .option("--yes", "Skip confirms; auto-create missing dest DB")
    .option("--debug", "Print docker/DB commands being executed")
    .option("--source <key>", "Database item key (skip interactive picker)")
    .option("--dest <key>", "Destination item key (skip interactive picker)")
    .option("--dump <path>", "Dump file path for restore (skip interactive browser)");
}

function addModeCommands(parent: Command): void {
  for (const mode of ["dump", "restore", "dump-restore"] as const) {
    addCommonOptions(
      parent.command(mode).description(MODE_DESCRIPTIONS[mode]),
    ).action(
      async (opts: {
        config: string;
        yes?: boolean;
        debug?: boolean;
        source?: string;
        dest?: string;
        dump?: string;
      }) => {
        await handleMain({
          config: opts.config,
          yes: opts.yes,
          debug: opts.debug,
          mode,
          source: opts.source,
          dest: opts.dest,
          dump: opts.dump,
        });
      },
    );
  }
}

const program = new Command();
program.enablePositionalOptions();

addCommonOptions(
  program
    .name("dumpmgr")
    .description(
      "Dump Manager — dump and restore Postgres databases via Docker",
    )
    .addHelpText(
      "after",
      [
        "Auxiliary commands:",
        "  autonomous          Run scheduled backups (cron + optional S3 upload)",
        "  doctor              Check Docker / dumps dir / metadata integrity",
        "  s3 upload           Upload a local dump to S3",
        "  s3 download         Browse and download a dump from S3",
        "  secret list         List stored DB password keys with metadata",
        "  secret history      Show rotation history for a secret key",
        "  secret wipe <key>   Remove a stored DB password by key",
        "  vault status        Show SQLite vault summary",
        "  audit list          List audit log entries",
        "  dump-registry list  List indexed dumps with SHA-256",
        "  dump-registry scan  Index existing dumps under dumps/",
        "  restore-history list  List restore operations",
        "  config {init|validate|lint}",
      ].join("\n"),
    ),
).action(async (opts: GlobalOpts) => {
  await handleMain(opts);
});

addModeCommands(program);

program
  .command("autonomous")
  .description(
    "Run scheduled backups from config autonomous.schedules (cron + optional S3)",
  )
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .option("--debug", "Print docker/DB commands being executed")
  .option("--once", "Run all schedules immediately once and exit")
  .action(async (opts: { config: string; debug?: boolean; once?: boolean }) => {
    const configPath = resolve(opts.config);
    if (!(await configExists(configPath))) {
      console.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }
    try {
      await runAutonomous({
        configPath,
        debug: opts.debug,
        once: opts.once,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      process.exit(1);
    }
  });

const s3Cmd = program
  .command("s3")
  .description("Manually upload or download dumps using configured S3");

for (const action of ["upload", "download"] as const) {
  s3Cmd
    .command(action)
    .description(action === "upload" ? "Upload a local dump to S3" : "Browse and download a dump from S3")
    .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
    .option("--yes", "Overwrite an existing local download")
    .action(async (opts: { config: string; yes?: boolean }) => {
      await handleS3Command(action, opts);
    });
}

// `dumpmgr doctor` — environment + metadata health check (no master unlock).
program
  .command("doctor")
  .description(
    "Check Docker daemon, dumps dir permissions, and metadata integrity",
  )
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .action(async (opts: { config: string }) => {
    const configPath = resolve(opts.config);
    p.intro("dumpmgr doctor");
    if (!(await configExists(configPath))) {
      p.log.error(`Config file not found: ${configPath}`);
      p.outro("config missing");
      process.exit(1);
    }
    let config: Config;
    try {
      config = await loadConfigAsync(configPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(message);
      p.outro("config invalid");
      process.exit(1);
    }
    const report = await runDoctor(config, configPath);
    for (const check of report.checks) {
      if (check.ok) {
        p.log.success(`${check.name}: ${check.message}`);
      } else {
        p.log.error(`${check.name}: ${check.message}`);
        if (check.hint) p.log.warn(`  hint: ${check.hint}`);
      }
    }
    p.outro(report.ok ? "doctor ok" : "doctor found problems");
    if (!report.ok) process.exit(1);
  });

// `dumpmgr secret list` / `dumpmgr secret wipe <key>` — inspect or remove
// saved DB passwords (keys only; values stay encrypted at rest).
const secretCmd = program
  .command("secret")
  .description("List or wipe saved DB passwords");

async function unlockForSecretOps(
  config: Config,
  configPath: string,
): Promise<Session | null> {
  if (!needsMaster(config)) {
    p.log.warn(
      "metadata has no master password; nothing to list/wipe. " +
        'Set "rememberPassword": true in config.jsonc.',
    );
    return null;
  }
  return await unlockOrNull(config, configPath);
}

secretCmd
  .command("list")
  .description("List stored DB password keys (values are never shown)")
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .action(async (opts: { config: string }) => {
    const configPath = resolve(opts.config);
    p.intro("dumpmgr secret list");
    if (!(await configExists(configPath))) {
      p.log.error(`Config file not found: ${configPath}`);
      p.outro("config missing");
      process.exit(1);
    }
    let config: Config;
    try {
      config = await loadConfigAsync(configPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(message);
      p.outro("config invalid");
      process.exit(1);
    }
    const session = await unlockForSecretOps(config, configPath);
    if (!session) {
      p.outro("nothing to list");
      return;
    }
    const secrets = listSecrets(session.db);
    if (secrets.length === 0) {
      p.log.info("No saved DB passwords.");
    } else {
      for (const s of secrets) {
        const last = s.lastUsedAt ? s.lastUsedAt.toISOString() : "-";
        p.log.info(
          `${s.key}\tcreated=${s.createdAt.toISOString()}\tupdated=${s.updatedAt.toISOString()}\tlast_used=${last}`,
        );
      }
    }
    session.db.close();
    p.outro(`${secrets.length} stored`);
  });

secretCmd
  .command("wipe <key>")
  .description("Remove a saved DB password by key (e.g. postgres:prod)")
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .option("--yes", "Skip confirmation prompt")
  .action(async (opts: { config: string; yes?: boolean }, args: { key: string }) => {
    const configPath = resolve(opts.config);
    const targetKey = args.key;
    p.intro(`dumpmgr secret wipe ${targetKey}`);
    if (!(await configExists(configPath))) {
      p.log.error(`Config file not found: ${configPath}`);
      p.outro("config missing");
      process.exit(1);
    }
    let config: Config;
    try {
      config = await loadConfigAsync(configPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(message);
      p.outro("config invalid");
      process.exit(1);
    }
    const session = await unlockForSecretOps(config, configPath);
    if (!session) {
      p.outro("nothing to wipe");
      return;
    }
    const stored = listSecrets(session.db).some((s) => s.key === targetKey);
    if (!stored) {
      p.log.warn(`"${targetKey}" is not stored.`);
      session.db.close();
      p.outro("no change");
      return;
    }
    if (!opts.yes) {
      const ok = await p.confirm({
        message: `Remove saved password for "${targetKey}"?`,
        initialValue: false,
      });
      if (p.isCancel(ok)) onCancel();
      if (!ok) {
        p.log.warn("wipe cancelled");
        session.db.close();
        p.outro("no change");
        return;
      }
    }
    const removed = await deleteDbPassword(session, targetKey);
    if (removed) {
      p.log.success(`Removed "${targetKey}".`);
      p.log.info(
        "Encrypted dumps remain unaffected (they use the master key, not per-DB passwords).",
      );
    } else {
      p.log.warn(`"${targetKey}" was already gone.`);
    }
    session.db.close();
    p.outro("done");
  });

secretCmd
  .command("history <key>")
  .description("Show rotation history for a secret key")
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .action(async (opts: { config: string }, args: { key: string }) => {
    const configPath = resolve(opts.config);
    p.intro(`dumpmgr secret history ${args.key}`);
    if (!(await configExists(configPath))) {
      p.log.error(`Config file not found: ${configPath}`);
      p.outro("config missing");
      process.exit(1);
    }
    let config: Config;
    try {
      config = await loadConfigAsync(configPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(message);
      p.outro("config invalid");
      process.exit(1);
    }
    const session = await unlockForSecretOps(config, configPath);
    if (!session) {
      p.outro("no history");
      return;
    }
    const rows = listSecretRotations(session.db, args.key, 50);
    if (rows.length === 0) {
      p.log.info(`No rotation history for "${args.key}".`);
    } else {
      for (const r of rows) {
        p.log.info(`${r.rotatedAt.toISOString()}  ${r.action}  ${r.secretKey}`);
      }
    }
    session.db.close();
    p.outro("done");
  });

const vaultCmd = program.command("vault").description("Inspect the SQLite vault database");
vaultCmd
  .command("status")
  .description("Show vault summary (counts, encId, path)")
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .action(async (opts: { config: string }) => {
    const configPath = resolve(opts.config);
    p.intro("dumpmgr vault status");
    const db = await openVault(configPath);
    try {
      const st = vaultStatus(db, dbPathForConfig(configPath));
      p.log.info(`path:          ${st.dbPath}`);
      p.log.info(`schema:        v${st.schemaVersion}`);
      p.log.info(`master:        ${st.hasMaster}`);
      p.log.info(`encId:         ${st.encId}`);
      p.log.info(`secrets:       ${st.secretCount}`);
      p.log.info(`dumps indexed: ${st.dumpCount}`);
      p.log.info(`audit entries: ${st.auditCount}`);
      p.log.info(`restores:      ${st.restoreCount}`);
    } finally {
      db.close();
    }
    p.outro("done");
  });

const auditCmd = program.command("audit").description("View audit log entries");
auditCmd
  .command("list")
  .description("List recent audit log entries")
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .option("--limit <n>", "Max entries", "50")
  .option("--action <name>", "Filter by action")
  .action(async (opts: { config: string; limit: string; action?: string }) => {
    const configPath = resolve(opts.config);
    p.intro("dumpmgr audit list");
    const db = await openVault(configPath);
    try {
      const entries = listAudit(db, opts.action ?? "", Number(opts.limit) || 50);
      if (entries.length === 0) {
        p.log.info("No audit entries.");
      } else {
        for (const e of entries) {
          p.log.info(
            `${e.occurredAt.toISOString()}\t${e.action}\t${e.status}\t${e.subject}\t${e.destination}`,
          );
        }
      }
    } finally {
      db.close();
    }
    p.outro("done");
  });

const dumpRegistryCmd = program
  .command("dump-registry")
  .description("Inspect indexed dump file metadata");

dumpRegistryCmd
  .command("list")
  .description("List indexed dumps with SHA-256 checksums")
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .option("--limit <n>", "Max entries", "100")
  .option("--item <key>", "Filter by database item key")
  .action(async (opts: { config: string; limit: string; item?: string }) => {
    const configPath = resolve(opts.config);
    const db = await openVault(configPath);
    try {
      const records = listDumps(db, opts.item ?? "", Number(opts.limit) || 100);
      if (records.length === 0) {
        p.log.info("No indexed dumps. Run `dumpmgr dump-registry scan` to index existing files.");
      } else {
        for (const d of records) {
          p.log.info(
            `${d.relativePath}\t${d.itemKey}\t${d.sha256}\t${d.sizeBytes}\t${d.encrypted}\t${d.createdAt.toISOString()}`,
          );
        }
      }
    } finally {
      db.close();
    }
    p.outro("done");
  });

dumpRegistryCmd
  .command("show <relative-path>")
  .description("Show metadata for one indexed dump")
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .action(async (opts: { config: string }, args: { relativePath: string }) => {
    const configPath = resolve(opts.config);
    const db = await openVault(configPath);
    try {
      const rec = getDumpByPath(db, args.relativePath);
      if (!rec) {
        p.log.warn(`Dump not indexed: ${args.relativePath}`);
      } else {
        p.log.info(`path:      ${rec.relativePath}`);
        p.log.info(`item:      ${rec.itemKey}`);
        p.log.info(`sha256:    ${rec.sha256}`);
        p.log.info(`size:      ${rec.sizeBytes} bytes`);
        p.log.info(`encrypted: ${rec.encrypted}`);
        p.log.info(`encId:     ${rec.encId}`);
        p.log.info(`created:   ${rec.createdAt.toISOString()}`);
      }
    } finally {
      db.close();
    }
    p.outro("done");
  });

dumpRegistryCmd
  .command("verify <relative-path>")
  .description("Verify on-disk SHA-256 matches the vault record")
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .action(async (opts: { config: string }, args: { relativePath: string }) => {
    const configPath = resolve(opts.config);
    const config = await loadConfigAsync(configPath);
    const dumpsRoot = resolveDumpsRoot(config.dumpDirectory);
    const db = await openVault(configPath);
    try {
      const rec = getDumpByPath(db, args.relativePath);
      if (!rec) throw new Error(`dump not indexed: ${args.relativePath}`);
      const full = join(dumpsRoot, args.relativePath);
      const { hash, size } = await sha256File(full);
      if (hash !== rec.sha256 || size !== rec.sizeBytes) {
        recordAudit(
          db,
          Action.DumpVerify,
          Status.Failure,
          args.relativePath,
          "",
          `want=${rec.sha256} got=${hash}`,
          "checksum mismatch",
        );
        throw new Error(`checksum mismatch for ${args.relativePath}`);
      }
      recordAudit(db, Action.DumpVerify, Status.Success, args.relativePath, "", "checksum ok", "");
      p.log.success(`${args.relativePath} checksum OK (${hash})`);
    } finally {
      db.close();
    }
    p.outro("done");
  });

dumpRegistryCmd
  .command("scan")
  .description("Index existing dump files under dumps/ (computes SHA-256)")
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .action(async (opts: { config: string }) => {
    const configPath = resolve(opts.config);
    const config = await loadConfigAsync(configPath);
    const dumpsRoot = resolveDumpsRoot(config.dumpDirectory);
    const db = await openVault(configPath);
    try {
      const n = await scanDumpsRoot(db, dumpsRoot);
      recordAudit(db, Action.DumpScan, Status.Success, dumpsRoot, "", `indexed=${n}`, "");
      p.log.success(`Indexed ${n} dump file(s)`);
    } finally {
      db.close();
    }
    p.outro("done");
  });

const restoreHistoryCmd = program
  .command("restore-history")
  .description("View restore history from the vault");
restoreHistoryCmd
  .command("list")
  .description("List recent restore operations")
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .option("--limit <n>", "Max entries", "50")
  .option("--destination <key>", "Filter by destination key")
  .action(async (opts: { config: string; limit: string; destination?: string }) => {
    const configPath = resolve(opts.config);
    const db = await openVault(configPath);
    try {
      const rows = listRestoreHistory(db, opts.destination ?? "", Number(opts.limit) || 50);
      if (rows.length === 0) {
        p.log.info("No restore history.");
      } else {
        for (const r of rows) {
          p.log.info(
            `${r.restoredAt.toISOString()}\t${r.status}\t${r.dumpRelativePath}\t${r.destinationKey}\t${r.durationMs}\t${r.dumpSha256}`,
          );
        }
      }
    } finally {
      db.close();
    }
    p.outro("done");
  });

const configCmd = program
  .command("config")
  .description("Manage config.jsonc");

configCmd
  .command("init")
  .description("Scaffold config.jsonc and metadata")
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .option("--with-fake-data", "Skip prompt; populate sample database items", false)
  .action(async (opts: { config: string; withFakeData: boolean }) => {
    try {
      p.intro("dumpmgr config init");
      await runInit({
        config: resolve(opts.config),
        // only skip the prompt when the flag is explicitly set
        withFakeData: opts.withFakeData ? true : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(message);
      process.exit(1);
    }
  });

configCmd
  .command("validate")
  .description("Validate config.jsonc and print a summary report")
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .action(async (opts: { config: string }) => {
    const configPath = resolve(opts.config);
    p.intro("dumpmgr config validate");
    const result = await validateConfigFile(configPath);
    if (!result.ok) {
      for (const issue of result.issues) p.log.error(issue);
      p.outro("config invalid");
      process.exit(1);
    }
    for (const line of result.report) {
      if (line) p.log.info(line);
    }
    for (const w of result.warnings) p.log.warn(w);
    p.outro(
      result.warnings.length > 0 ? "config ok (with warnings)" : "config ok",
    );
  });

configCmd
  .command("lint")
  .description("Format config.jsonc in place (preserves comments)")
  .option("-c, --config <path>", "Path to config.jsonc", DEFAULT_CONFIG_PATH)
  .action(async (opts: { config: string }) => {
    const configPath = resolve(opts.config);
    p.intro("dumpmgr config lint");
    try {
      await lintConfigFile(configPath);
      p.log.success(`Formatted ${configPath}`);
      p.outro("done");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(message);
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
