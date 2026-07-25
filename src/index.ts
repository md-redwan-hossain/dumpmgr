#!/usr/bin/env bun
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Command } from "commander";
import * as p from "@clack/prompts";
import ora from "ora";
import {
  configExists,
  dbKey,
  engineImage,
  engineItemCount,
  engineItems,
  getParentItem,
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
  dropDatabase,
  DUMP_COMPRESS,
  dumpDatabase,
  maintenanceDb,
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
  metadataPathForConfig,
  setDbPassword,
  unlockSession,
  type Session,
} from "./metadata.ts";
import {
  browseDumpFile,
  confirmOrYes,
  connectWithRetry,
  onCancel,
  promptPassword,
  resolveDbPassword,
  selectDatabaseItem,
  selectDatabaseTree,
  selectEngine,
  selectMode,
  selectNestedRestoreAction,
} from "./prompt.ts";

type CliMode = "dump" | "restore" | "dump-restore";

type GlobalOpts = {
  config: string;
  yes?: boolean;
  debug?: boolean;
  engine?: Engine;
  mode?: CliMode;
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
  yes?: boolean,
): Promise<void> {
  const image = engineImage(config, engine);
  const exists = await databaseExists(engine, image, dest);
  if (exists) return;
  const create = await confirmOrYes(
    `Database "${dest.database}" does not exist on destination (${destName}). Create it?`,
    yes,
    false,
  );
  if (!create) {
    throw new Error("Destination database does not exist. Aborted.");
  }
  p.log.step(`Creating database "${dest.database}"…`);
  await createDatabase(engine, image, dest);
  p.log.success(`Created "${dest.database}"`);
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
  const encId = session.metadata.encId;
  p.log.step("Re-encrypting saved database passwords…");
  const updated = await changeMasterPassword(session, next);
  p.log.success("Database passwords re-encrypted");

  const dumpsRoot = resolveDumpsRoot(config.dumpDirectory);
  if (encId && (await hasEncryptedDumpsWithEncId(dumpsRoot, encId))) {
    const action = await p.select({
      message: "What should happen to existing dumps?",
      options: [
        { value: "reencrypt", label: "Re-encrypt dumps" },
        { value: "delete", label: "Delete matching encrypted dumps" },
      ],
    });
    if (p.isCancel(action)) onCancel();

    if (action === "delete") {
      const n = await deleteEncryptedDumpsWithEncId(dumpsRoot, encId);
      p.log.success(`Deleted ${n} encrypted dump(s)`);
    } else {
      await ensureDumpsRootWritable(dumpsRoot);
      const n = await reencryptAllDumps(
        dumpsRoot,
        oldKey,
        updated.aesKey!,
        encId,
      );
      p.log.success(`Re-encrypted ${n} dump file(s)`);
    }
  }

  p.log.success("Master password changed");
  return updated;
}

async function resolveEngine(
  config: Config,
  fixed: Engine | undefined,
  minItems: number,
): Promise<Engine> {
  if (!fixed) return selectEngine(config, minItems);
  if (engineItemCount(config, fixed) < minItems) {
    throw new Error(
      `${fixed} needs at least ${minItems} database item(s). Edit config.json.`,
    );
  }
  return fixed;
}

async function runMode(
  mode: "dump-restore" | "dump" | "restore",
  opts: GlobalOpts,
  config: Config,
  session: Session | null,
): Promise<void> {
  const minItems = mode === "dump-restore" ? 2 : 1;
  const engine = await resolveEngine(config, opts.engine, minItems);
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
      const encId = session.metadata.encId;
      if (!encId) throw new Error("encId missing from metadata");
      p.log.step("Encrypting dump…");
      finalPath = await encryptDumpFile(finalPath, session.aesKey, encId);
      p.log.success(`Encrypted (${formatBytes(Bun.file(finalPath).size)})`);
    }

    p.log.success(`Dump saved at ${finalPath}`);
    return;
  }

  if (mode === "restore") {
    const engineDumps = join(dumpsRoot, engine);
    const dumpPath = await browseDumpFile(engineDumps, config.encryptedDump);
    const fileName = basename(dumpPath);
    const dir = dirname(dumpPath);

    const destItem = await selectDatabaseTree(
      config,
      engine,
      "Select destination database",
    );

    let destDb: ResolvedDb;

    if (destItem.nested && destItem.parentKey) {
      const parentItem = getParentItem(config, engine, destItem.parentKey);
      if (!parentItem) {
        throw new Error(
          `Nested destination "${destItem.key}" needs parent "${destItem.parentKey}" with user+database for connection verify.`,
        );
      }

      p.log.step(`Verifying parent "${parentItem.key}"…`);
      const parentDb = await resolveConnectedDb({
        config,
        session,
        engine,
        item: parentItem,
        role: "destination",
        maintenance: true,
      });
      p.log.success(`Parent "${parentItem.key}" OK`);

      const childExists = await databaseExists(engine, image, {
        ...parentDb,
        database: destItem.database,
      });

      const action = await selectNestedRestoreAction(
        `Restore "${fileName}" into "${destItem.key}"?`,
        childExists,
      );
      if (action === "no") {
        p.log.warn("Restore cancelled");
        return;
      }

      // Nested DBs are created/owned via parent login; reuse that auth for restore
      destDb = {
        ...destItem,
        user: parentDb.user,
        password: parentDb.password,
      };

      if (action === "drop") {
        p.log.step(`Dropping database "${destItem.database}"…`);
        await dropDatabase(engine, image, {
          ...parentDb,
          database: destItem.database,
        });
        p.log.step(`Creating database "${destItem.database}"…`);
        await createDatabase(engine, image, {
          ...parentDb,
          database: destItem.database,
        });
        p.log.success(`Recreated "${destItem.database}"`);
      } else if (action === "create") {
        p.log.step(`Creating database "${destItem.database}"…`);
        await createDatabase(engine, image, {
          ...parentDb,
          database: destItem.database,
        });
        p.log.success(`Created "${destItem.database}"`);
      }
      // action === "yes": restore as-is
    } else {
      destDb = await resolveConnectedDb({
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
  const destItem = await selectDatabaseTree(
    config,
    engine,
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
      `Source:      ${sourceItem.key} → ${sourceDb.user}@${sourceDb.host}:${sourceDb.port}/${sourceDb.database}`,
      `Destination: ${destItem.key} → ${destDb.user}@${destDb.host}:${destDb.port}/${destDb.database}`,
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
    const encId = session.metadata.encId;
    if (!encId) throw new Error("encId missing from metadata");
    p.log.step("Encrypting dump…");
    finalPath = await encryptDumpFile(finalPath, session.aesKey, encId);
    p.log.success(`Encrypted (${formatBytes(Bun.file(finalPath).size)})`);
  }

  p.log.info(`Dump kept at ${finalPath}`);
  p.log.success(`Synced ${sourceItem.key} → ${destItem.key}`);
}

async function runMain(opts: GlobalOpts): Promise<void> {
  if (opts.debug) {
    setDockerDebug(true, (msg) => p.log.info(msg));
  }

  const engineLabel = opts.engine ? ` (${opts.engine})` : "";
  p.intro(`dbsync — docker based db dump & sync tool${engineLabel}`);
  if (opts.debug) p.log.info("Debug mode on");

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

  if (opts.mode) {
    try {
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

function addCommonOptions(cmd: Command): Command {
  // ponytail: commander treats a boolean 3rd arg as parseFn, so no `false` default
  return cmd
    .option("-c, --config <path>", "Path to config.json", "config.json")
    .option("--yes", "Skip confirms; auto-create missing dest DB")
    .option("--debug", "Print docker/DB commands being executed");
}

function addModeCommands(parent: Command, engine?: Engine): void {
  for (const mode of ["dump", "restore", "dump-restore"] as const) {
    addCommonOptions(
      parent.command(mode).description(MODE_DESCRIPTIONS[mode]),
    ).action(async (opts: { config: string; yes?: boolean; debug?: boolean }) => {
      await handleMain({
        config: opts.config,
        yes: opts.yes,
        debug: opts.debug,
        engine,
        mode,
      });
    });
  }
}

const program = new Command();
program.enablePositionalOptions();

addCommonOptions(
  program
    .name("dbsync")
    .description(
      "Dump and sync Postgres / MySQL / MariaDB databases via Docker",
    ),
).action(async (opts: GlobalOpts) => {
  await handleMain(opts);
});

addModeCommands(program);

function addEngineCommand(name: string, engine: Engine, aliases?: string[]) {
  const cmd = addCommonOptions(
    program
      .command(name)
      .description(`Run dbsync locked to ${engine}`)
      .enablePositionalOptions(),
  ).action(async (opts: { config: string; yes?: boolean; debug?: boolean }) => {
    await handleMain({
      config: opts.config,
      yes: opts.yes,
      debug: opts.debug,
      engine,
    });
  });
  if (aliases) {
    for (const a of aliases) cmd.alias(a);
  }
  addModeCommands(cmd, engine);
}

addEngineCommand("pg", "postgres", ["postgres"]);
addEngineCommand("mysql", "mysql");
addEngineCommand("mariadb", "mariadb");

program
  .command("init")
  .description("Scaffold config.json and metadata")
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
