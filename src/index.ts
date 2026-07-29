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
  getParentItem,
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
  createDatabase,
  databaseExists,
  dropDatabase,
  DUMP_COMPRESS,
  dumpDatabase,
  ensureDatabaseLogin,
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
  deleteDbPassword,
  getDbPassword,
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
  promptConfirmedPassword,
  promptPassword,
  requireItems,
  resolveDbPassword,
  selectDatabaseItem,
  selectDatabaseTree,
  selectMode,
  selectNestedCreatePassword,
  selectNestedRestoreAction,
  selectReplaceExistingObjects,
} from "./prompt.ts";

type CliMode = "dump" | "restore" | "dump-restore";

type GlobalOpts = {
  config: string;
  yes?: boolean;
  debug?: boolean;
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

async function ensureDestDatabase(
  config: Config,
  dest: ResolvedDb,
  destName: string,
  yes?: boolean,
): Promise<{ created: boolean }> {
  const image = configImage(config);
  const exists = await databaseExists(image, dest);
  if (exists) return { created: false };
  const create = await confirmOrYes(
    `Database "${dest.database}" does not exist on destination (${destName}). Create it?`,
    yes,
    false,
  );
  if (!create) {
    throw new Error("Destination database does not exist. Aborted.");
  }
  p.log.step(`Creating database "${dest.database}"…`);
  await createDatabase(image, dest);
  p.log.success(`Created "${dest.database}"`);
  return { created: true };
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
      const n = await reencryptAllDumps(dumpsRoot, oldKey, updated.aesKey!, encId);
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
    const sourceItem = await selectDatabaseItem(items, "Select database to dump");
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
    const dumpPath = await browseDumpFile(dumpsRoot, config.encryptedDump);
    const fileName = basename(dumpPath);
    const dir = dirname(dumpPath);

    const destItem = await selectDatabaseTree(config, "Select destination database");

    let destDb: ResolvedDb;
    let intoExisting = false;

    if (destItem.nested && destItem.parentKey) {
      const parentItem = getParentItem(config, destItem.parentKey);
      if (!parentItem) {
        throw new Error(
          `Nested destination "${destItem.key}" needs parent "${destItem.parentKey}" with user+database for connection verify.`,
        );
      }

      p.log.step(`Verifying parent "${parentItem.key}"…`);
      const parentDb = await resolveConnectedDb({
        config,
        session,
        item: parentItem,
        role: "destination",
      });
      p.log.success(`Parent "${parentItem.key}" OK`);

      const parentLogin = parentDb.database;
      const childTarget = { ...parentDb, database: destItem.database };
      const connectOpts = { connectDatabase: parentLogin };

      const childExists = await databaseExists(image, childTarget, connectOpts);

      const action = await selectNestedRestoreAction(
        `Restore "${fileName}" into "${destItem.key}"?`,
        childExists,
      );
      if (action === "no") {
        p.log.warn("Restore cancelled");
        return;
      }

      if (action === "drop") {
        p.log.step(`Dropping database "${destItem.database}"…`);
        await dropDatabase(image, childTarget, connectOpts);
        p.log.step(`Creating database "${destItem.database}"…`);
        await createDatabase(image, childTarget, connectOpts);
        p.log.success(`Recreated "${destItem.database}"`);
      } else if (action === "create") {
        p.log.step(`Creating database "${destItem.database}"…`);
        await createDatabase(image, childTarget, connectOpts);
        p.log.success(`Created "${destItem.database}"`);
      }

      if (action === "create" || action === "drop") {
        if (parentDb.user === destItem.user) {
          destDb = { ...destItem, user: parentDb.user, password: parentDb.password };
        } else {
          const childKey = dbKey(destItem.key);
          const saved =
            session && config.rememberPassword
              ? await getDbPassword(session, childKey)
              : null;
          const pwSource = opts.yes
            ? "parent"
            : await selectNestedCreatePassword({ hasSaved: Boolean(saved) });

          if (pwSource === "parent") {
            destDb = { ...destItem, user: parentDb.user, password: parentDb.password };
          } else if (pwSource === "saved") {
            if (!saved) throw new Error(`No saved password for "${destItem.key}"`);
            destDb = { ...destItem, password: saved };
          } else {
            const password = await promptConfirmedPassword(
              `password for ${destItem.key} (${destItem.user})`,
            );
            p.log.step(`Ensuring login "${destItem.user}"…`);
            await ensureDatabaseLogin(image, parentDb, {
              user: destItem.user,
              password,
              database: destItem.database,
              connectDatabase: parentLogin,
            });
            if (config.rememberPassword && session) {
              await setDbPassword(session, childKey, password);
            }
            destDb = { ...destItem, password };
            p.log.success(`Login "${destItem.user}" ready`);
          }
        }
      } else {
        // action === "yes": restore into existing with parent creds
        intoExisting = true;
        destDb = { ...destItem, user: parentDb.user, password: parentDb.password };
      }
    } else {
      destDb = await resolveConnectedDb({
        config,
        session,
        item: destItem,
        role: "destination",
        maintenance: true,
      });
      const { created } = await ensureDestDatabase(config, destDb, destItem.key, opts.yes);
      intoExisting = !created;

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
      await runRestoreWithSpinner(image, destDb, restoreDir, restoreName, destItem.key, { clean });
    } finally {
      if (tempPlain) await rm(tempPlain, { force: true });
    }

    p.log.success(`Restored ${fileName} → ${destItem.key}`);
    return;
  }

  // dump-restore
  const sourceItem = await selectDatabaseItem(items, "Select source database");
  const destItem = await selectDatabaseTree(config, "Select destination database", sourceItem.key);

  const sourceDb = await resolveConnectedDb({ config, session, item: sourceItem, role: "source" });
  const destDb = await resolveConnectedDb({
    config,
    session,
    item: destItem,
    role: "destination",
    maintenance: true,
  });
  const { created: destCreated } = await ensureDestDatabase(
    config,
    destDb,
    destItem.key,
    opts.yes,
  );

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

  const clean = await resolveRestoreClean({ intoExisting: !destCreated, yes: opts.yes });

  const dir = dbDumpDir(dumpsRoot, sourceItem.key);
  await mkdir(dir, { recursive: true });
  const plainName = newDumpFileName(sourceItem.key);
  await runDumpWithSpinner(image, sourceDb, dir, plainName, sourceItem.key);
  await runRestoreWithSpinner(image, destDb, dir, plainName, destItem.key, { clean });

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

  p.intro(`dumpmgr — Dump Manager, docker based db dump & restore tool`);
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
  if (config.encryptedDump && !config.rememberPassword) {
    p.log.warn(
      `encryptedDump is true but rememberPassword is false. ` +
        `Encrypted dumps need the master-derived AES key, so set ` +
        `"rememberPassword": true in config.json (or disable encryptedDump).`,
    );
  }
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

function addModeCommands(parent: Command): void {
  for (const mode of ["dump", "restore", "dump-restore"] as const) {
    addCommonOptions(
      parent.command(mode).description(MODE_DESCRIPTIONS[mode]),
    ).action(async (opts: { config: string; yes?: boolean; debug?: boolean }) => {
      await handleMain({ config: opts.config, yes: opts.yes, debug: opts.debug, mode });
    });
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
        "  doctor              Check Docker / dumps dir / metadata integrity",
        "  secret list         List stored DB password keys (no values)",
        "  secret wipe <key>   Remove a stored DB password by key",
        "  config {init|validate|lint}",
      ].join("\n"),
    ),
).action(async (opts: GlobalOpts) => {
  await handleMain(opts);
});

addModeCommands(program);

// `dumpmgr doctor` — environment + metadata health check (no master unlock).
program
  .command("doctor")
  .description(
    "Check Docker daemon, dumps dir permissions, and metadata integrity",
  )
  .option("-c, --config <path>", "Path to config.json", "config.json")
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
        'Set "rememberPassword": true in config.json.',
    );
    return null;
  }
  return await unlockOrNull(config, configPath);
}

secretCmd
  .command("list")
  .description("List stored DB password keys (values are never shown)")
  .option("-c, --config <path>", "Path to config.json", "config.json")
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
    const keys = Object.keys(session.metadata.dbPasswords).sort();
    if (keys.length === 0) {
      p.log.info("No saved DB passwords.");
    } else {
      for (const k of keys) p.log.info(k);
    }
    p.outro(`${keys.length} stored`);
  });

secretCmd
  .command("wipe <key>")
  .description("Remove a saved DB password by key (e.g. postgres:prod)")
  .option("-c, --config <path>", "Path to config.json", "config.json")
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
    if (!(targetKey in session.metadata.dbPasswords)) {
      p.log.warn(`"${targetKey}" is not stored.`);
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
    p.outro("done");
  });

const configCmd = program
  .command("config")
  .description("Manage config.json");

configCmd
  .command("init")
  .description("Scaffold config.json and metadata")
  .option("-c, --config <path>", "Path to config.json", "config.json")
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
  .description("Validate config.json and print a summary report")
  .option("-c, --config <path>", "Path to config.json", "config.json")
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
  .description("Format config.json in place")
  .option("-c, --config <path>", "Path to config.json", "config.json")
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
