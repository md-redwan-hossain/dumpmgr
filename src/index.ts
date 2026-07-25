#!/usr/bin/env bun
import { mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Command } from "commander";
import * as p from "@clack/prompts";
import ora from "ora";
import {
  configExists,
  dbKey,
  engineImage,
  engineItems,
  loadConfigAsync,
  needsMaster,
  type Config,
  type DatabaseItem,
  type Engine,
} from "./config.ts";
import {
  assertDockerAvailable,
  createDatabase,
  databaseExists,
  DUMP_COMPRESS,
  dumpDatabase,
  maintenanceDb,
  restoreDatabase,
  restoreJobs,
  verifyConnection,
  type ResolvedDb,
} from "./docker.ts";
import {
  dbDumpDir,
  deleteAllDumps,
  decryptDumpToTemp,
  encryptDumpFile,
  ensureDumpsRootWritable,
  formatBytes,
  formatDuration,
  isEncryptedDumpName,
  listDumpFiles,
  newDumpFileName,
  plainTempNameFromEncrypted,
  reencryptAllDumps,
  resolveDumpsRoot,
} from "./dumps.ts";
import { runInit } from "./init.ts";
import {
  changeMasterPassword,
  metadataPathForConfig,
  setDbPassword,
  unlockSession,
  type Session,
} from "./metadata.ts";
import {
  confirmOrYes,
  connectWithRetry,
  onCancel,
  promptPassword,
  resolveDbPassword,
  selectDatabaseItem,
  selectDumpFile,
  selectEngine,
  selectMode,
} from "./prompt.ts";

type GlobalOpts = {
  config: string;
  yes: boolean;
};

async function unlockOrNull(config: Config, configPath: string): Promise<Session | null> {
  if (!needsMaster(config)) return null;
  const metaPath = metadataPathForConfig(configPath);
  for (;;) {
    const master = await promptPassword("master password");
    try {
      return await unlockSession(metaPath, master);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(message);
      const again = await p.confirm({ message: "Try again?", initialValue: true });
      if (p.isCancel(again) || !again) onCancel();
    }
  }
}

async function resolveConnectedDb(opts: {
  config: Config;
  session: Session | null;
  engine: Engine;
  item: DatabaseItem;
  role: "source" | "destination";
  maintenance?: boolean;
}): Promise<ResolvedDb> {
  const image = engineImage(opts.config, opts.engine);
  const key = dbKey(opts.engine, opts.item.key);

  const password = await connectWithRetry({
    label: opts.item.key,
    getPassword: () =>
      resolveDbPassword({
        session: opts.session,
        rememberPassword: opts.config.rememberPassword,
        engine: opts.engine,
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
        opts.engine,
        image,
        opts.role,
        opts.item.key,
        db,
        opts.maintenance
          ? { database: maintenanceDb(opts.engine) }
          : undefined,
      );
    },
  });

  return { ...opts.item, password };
}

async function runDumpWithSpinner(
  engine: Engine,
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
    await dumpDatabase(engine, image, db, workdir, dumpFileName);
  } catch (err) {
    clearInterval(tick);
    spinner.fail("Dump failed");
    throw err;
  }
  clearInterval(tick);
  const elapsedMs = performance.now() - t0;
  const size = Bun.file(dumpPath).size;
  spinner.succeed(
    `Dump complete in ${formatDuration(elapsedMs)} (${formatBytes(size)})`,
  );
  return { elapsedMs, size, path: dumpPath };
}

async function runRestoreWithSpinner(
  engine: Engine,
  image: string,
  db: ResolvedDb,
  workdir: string,
  dumpFileName: string,
  label: string,
): Promise<number> {
  const jobsHint =
    engine === "postgres" ? ` (--jobs ${restoreJobs()})` : "";
  const spinner = ora({
    text: `Restoring ${label}${jobsHint}… 0.0s`,
  }).start();
  const t0 = performance.now();
  const tick = setInterval(() => {
    spinner.text = `Restoring ${label}${jobsHint}… ${formatDuration(performance.now() - t0)}`;
  }, 100);
  try {
    await restoreDatabase(engine, image, db, workdir, dumpFileName);
  } catch (err) {
    clearInterval(tick);
    spinner.fail("Restore failed");
    throw err;
  }
  clearInterval(tick);
  const elapsedMs = performance.now() - t0;
  spinner.succeed(`Restore complete in ${formatDuration(elapsedMs)}`);
  return elapsedMs;
}

async function ensureDestDatabase(
  config: Config,
  engine: Engine,
  dest: ResolvedDb,
  destName: string,
  yes: boolean,
): Promise<void> {
  const image = engineImage(config, engine);
  const exists = await databaseExists(engine, image, dest);
  if (exists) return;
  const create = await confirmOrYes(
    `Database "${dest.name}" does not exist on destination (${destName}). Create it?`,
    yes,
    false,
  );
  if (!create) {
    throw new Error("Destination database does not exist. Aborted.");
  }
  p.log.step(`Creating database "${dest.name}"…`);
  await createDatabase(engine, image, dest);
  p.log.success(`Created "${dest.name}"`);
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
  p.log.step("Re-encrypting saved database passwords…");
  const updated = await changeMasterPassword(session, next);
  p.log.success("Database passwords re-encrypted");

  const dumpsRoot = resolveDumpsRoot(config.dumpDirectory);
  const action = await p.select({
    message: "What should happen to existing dumps?",
    options: [
      { value: "reencrypt", label: "Re-encrypt dumps" },
      { value: "delete", label: "Delete all dumps" },
    ],
  });
  if (p.isCancel(action)) onCancel();

  if (action === "delete") {
    await deleteAllDumps(dumpsRoot);
    p.log.success(`Deleted dumps under ${dumpsRoot}`);
  } else {
    await ensureDumpsRootWritable(dumpsRoot);
    const n = await reencryptAllDumps(dumpsRoot, oldKey, updated.aesKey!);
    p.log.success(`Re-encrypted ${n} dump file(s)`);
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
  const engine = await selectEngine(config, minItems);
  const items = engineItems(config, engine);
  const image = engineImage(config, engine);
  const dumpsRoot = resolveDumpsRoot(config.dumpDirectory);
  await ensureDumpsRootWritable(dumpsRoot);

  if (mode === "dump") {
    const sourceItem = await selectDatabaseItem(items, "Select database to dump");
    const sourceDb = await resolveConnectedDb({
      config,
      session,
      engine,
      item: sourceItem,
      role: "source",
    });

    const dir = dbDumpDir(dumpsRoot, engine, sourceItem.key);
    await mkdir(dir, { recursive: true });
    const plainName = newDumpFileName(engine, sourceItem.key);
    await runDumpWithSpinner(
      engine,
      image,
      sourceDb,
      dir,
      plainName,
      sourceItem.key,
    );

    let finalPath = join(dir, plainName);
    if (config.encryptedDump) {
      if (!session?.aesKey) throw new Error("AES key required for encrypted dumps");
      p.log.step("Encrypting dump…");
      finalPath = await encryptDumpFile(finalPath, session.aesKey);
      p.log.success(`Encrypted (${formatBytes(Bun.file(finalPath).size)})`);
    }

    p.log.success(`Dump saved at ${finalPath}`);
    return;
  }

  if (mode === "restore") {
    const folderItem = await selectDatabaseItem(
      items,
      "Select dump folder (database name)",
    );
    const dir = dbDumpDir(dumpsRoot, engine, folderItem.key);
    const files = await listDumpFiles(dir, config.encryptedDump);
    const fileName = await selectDumpFile(files, "Select dump file");
    const destItem = await selectDatabaseItem(
      items,
      "Select destination database",
    );
    const destDb = await resolveConnectedDb({
      config,
      session,
      engine,
      item: destItem,
      role: "destination",
      maintenance: true,
    });
    await ensureDestDatabase(config, engine, destDb, destItem.key, opts.yes);

    const confirmed = await confirmOrYes(
      `Restore "${fileName}" into "${destItem.key}"?`,
      opts.yes,
      false,
    );
    if (!confirmed) {
      p.log.warn("Restore cancelled");
      return;
    }

    let restoreDir = dir;
    let restoreName = fileName;
    let tempPlain: string | null = null;

    if (isEncryptedDumpName(fileName)) {
      if (!session?.aesKey) throw new Error("AES key required to decrypt dump");
      tempPlain = join(
        dir,
        `.dbsync-decrypt-${Date.now()}_${plainTempNameFromEncrypted(fileName)}`,
      );
      p.log.step("Decrypting dump…");
      await decryptDumpToTemp(join(dir, fileName), session.aesKey, tempPlain);
      restoreDir = dir;
      restoreName = basename(tempPlain);
    }

    try {
      await runRestoreWithSpinner(
        engine,
        image,
        destDb,
        restoreDir,
        restoreName,
        destItem.key,
      );
    } finally {
      if (tempPlain) await rm(tempPlain, { force: true });
    }

    p.log.success(`Restored ${fileName} → ${destItem.key}`);
    return;
  }

  // dump-restore
  const sourceItem = await selectDatabaseItem(items, "Select source database");
  const destItem = await selectDatabaseItem(
    items,
    "Select destination database",
    sourceItem.key,
  );

  const sourceDb = await resolveConnectedDb({
    config,
    session,
    engine,
    item: sourceItem,
    role: "source",
  });
  const destDb = await resolveConnectedDb({
    config,
    session,
    engine,
    item: destItem,
    role: "destination",
    maintenance: true,
  });
  await ensureDestDatabase(config, engine, destDb, destItem.key, opts.yes);

  p.note(
    [
      `Engine:      ${engine}`,
      `Source:      ${sourceItem.key} → ${sourceDb.user}@${sourceDb.host}:${sourceDb.port}/${sourceDb.name}`,
      `Destination: ${destItem.key} → ${destDb.user}@${destDb.host}:${destDb.port}/${destDb.name}`,
      `Image:       ${image}`,
      engine === "postgres" ? `Compress:    ${DUMP_COMPRESS}` : undefined,
      `Dumps:       ${dumpsRoot}`,
      `Encrypted:   ${config.encryptedDump}`,
    ]
      .filter(Boolean)
      .join("\n"),
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

  const dir = dbDumpDir(dumpsRoot, engine, sourceItem.key);
  await mkdir(dir, { recursive: true });
  const plainName = newDumpFileName(engine, sourceItem.key);
  await runDumpWithSpinner(
    engine,
    image,
    sourceDb,
    dir,
    plainName,
    sourceItem.key,
  );

  await runRestoreWithSpinner(
    engine,
    image,
    destDb,
    dir,
    plainName,
    destItem.key,
  );

  let finalPath = join(dir, plainName);
  if (config.encryptedDump) {
    if (!session?.aesKey) throw new Error("AES key required for encrypted dumps");
    p.log.step("Encrypting dump…");
    finalPath = await encryptDumpFile(finalPath, session.aesKey);
    p.log.success(`Encrypted (${formatBytes(Bun.file(finalPath).size)})`);
  }

  p.log.info(`Dump kept at ${finalPath}`);
  p.log.success(`Synced ${sourceItem.key} → ${destItem.key}`);
}

async function runMain(opts: GlobalOpts): Promise<void> {
  p.intro("dbsync — docker based db dump & sync tool");

  try {
    await assertDockerAvailable();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(message);
    process.exit(1);
  }

  const configPath = resolve(opts.config);
  if (!(await configExists(configPath))) {
    p.log.error(`Config file not found: ${configPath}`);
    const choice = await p.select({
      message: "Run init to create config?",
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
      await runMode(mode, opts, config, session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(message);
    }
  }
}

const program = new Command();

program
  .name("dbsync")
  .description(
    "Dump and sync Postgres / MySQL / MariaDB databases via Docker",
  )
  .option("-c, --config <path>", "Path to config.json", "config.json")
  .option("--yes", "Skip confirms; auto-create missing dest DB", false)
  .action(async (opts: GlobalOpts) => {
    try {
      await runMain(opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(message);
      process.exit(1);
    }
  });

program
  .command("init")
  .description("Scaffold config.json and metadata.json")
  .option("-c, --config <path>", "Path to config.json", "config.json")
  .option("--with-fake-data", "Skip prompt; populate sample database items", false)
  .action(async (opts: { config: string; withFakeData: boolean }) => {
    try {
      p.intro("dbsync init");
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

await program.parseAsync(process.argv);
