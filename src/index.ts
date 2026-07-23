#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import * as p from "@clack/prompts";
import { loadConfigAsync, type Database } from "./config.ts";
import {
  confirmOrYes,
  promptPasswordIfMissing,
  selectDatabase,
} from "./prompt.ts";
import {
  createDatabase,
  databaseExists,
  DUMP_COMPRESS,
  pgDump,
  pgDumpRestorePipe,
  pgRestore,
  restoreJobs,
  verifyConnection,
  type ResolvedDb,
} from "./docker.ts";

type Options = {
  config: string;
  keepDump: boolean;
  yes: boolean;
};

async function withPassword(
  label: string,
  db: Database,
): Promise<ResolvedDb> {
  const password = await promptPasswordIfMissing(label, db);
  return { ...db, password };
}

async function run(opts: Options): Promise<void> {
  p.intro("dbsync — docker based db dump & sync tool");

  const config = await loadConfigAsync(resolve(opts.config));

  const source = await selectDatabase(config, "Select source database");
  const dest = await selectDatabase(
    config,
    "Select destination database",
    source.name,
  );

  const sourceDb = await withPassword(source.name, source.db);
  const destDb = await withPassword(dest.name, dest.db);

  p.log.step("Verifying connections…");
  await verifyConnection(config.image, "source", source.name, sourceDb);
  // Dest DB may not exist yet — auth against maintenance DB `postgres`.
  await verifyConnection(config.image, "destination", dest.name, destDb, {
    database: "postgres",
  });
  p.log.success("Source and destination credentials OK");

  const exists = await databaseExists(config.image, destDb);
  if (!exists) {
    const create = await confirmOrYes(
      `Database "${destDb.dbname}" does not exist on destination (${dest.name}). Create it?`,
      opts.yes,
      false,
    );
    if (!create) {
      p.cancel("Destination database does not exist. Aborted.");
      process.exit(1);
    }
    p.log.step(`Creating database "${destDb.dbname}"…`);
    await createDatabase(config.image, destDb);
    p.log.success(`Created "${destDb.dbname}"`);
  }

  const transfer = opts.keepDump
    ? `file + pg_restore -j ${restoreJobs()}`
    : "streamed dump → restore (no temp file)";

  p.note(
    [
      `Source:      ${source.name} → ${sourceDb.user}@${sourceDb.host}:${sourceDb.port}/${sourceDb.dbname}`,
      `Destination: ${dest.name} → ${destDb.user}@${destDb.host}:${destDb.port}/${destDb.dbname}`,
      `Image:       ${config.image}`,
      `Compress:    ${DUMP_COMPRESS} (-Fc)`,
      `Transfer:    ${transfer}`,
    ].join("\n"),
    "Sync plan",
  );

  const confirmed = await confirmOrYes(
    `Overwrite destination "${dest.name}" with dump from "${source.name}"?`,
    opts.yes,
    false,
  );
  if (!confirmed) {
    p.cancel("Aborted.");
    process.exit(0);
  }

  if (opts.keepDump) {
    const workdir = join(tmpdir(), "dbsync");
    await mkdir(workdir, { recursive: true });
    const dumpFileName = `${source.name}-to-${dest.name}-${Date.now()}.dump`;
    const dumpPath = join(workdir, dumpFileName);

    p.log.step(`Dumping ${source.name} (${DUMP_COMPRESS})…`);
    await pgDump(config.image, sourceDb, workdir, dumpFileName);
    p.log.success("Dump complete");

    p.log.step(`Restoring into ${dest.name} (-j ${restoreJobs()})…`);
    await pgRestore(config.image, destDb, workdir, dumpFileName);
    p.log.success("Restore complete");

    p.log.info(`Dump kept at ${dumpPath}`);
  } else {
    p.log.step(
      `Streaming ${source.name} → ${dest.name} (${DUMP_COMPRESS})…`,
    );
    await pgDumpRestorePipe(config.image, sourceDb, destDb);
    p.log.success("Dump and restore complete");
  }

  p.outro(`Synced ${source.name} → ${dest.name}`);
}

const program = new Command();

program
  .name("dbsync")
  .description("Copy a Postgres database from source to destination via Docker")
  .option("-c, --config <path>", "Path to config.json", "config.json")
  .option("--keep-dump", "Keep the dump file after restore", false)
  .option("--yes", "Skip confirms; auto-create missing dest DB", false)
  .action(async (opts: Options) => {
    try {
      await run(opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(message);
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
