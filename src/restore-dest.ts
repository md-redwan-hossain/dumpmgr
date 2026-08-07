import * as p from "@clack/prompts";
import type { Config, DatabaseItem } from "./config.ts";
import { dbKey, configImage, getParentItem } from "./config.ts";
import {
  createDatabase,
  databaseExists,
  dropDatabase,
  ensureDatabaseLogin,
  verifyConnection,
  type ResolvedDb,
} from "./docker.ts";
import { getDbPassword, setDbPassword, type Session } from "./metadata.ts";
import {
  confirmOrYes,
  connectWithRetry,
  promptConfirmedPassword,
  resolveDbPassword,
  selectNestedCreatePassword,
  selectNestedRestoreAction,
} from "./prompt.ts";

export type PrepareRestoreDestinationOpts = {
  config: Config;
  session: Session | null;
  destItem: DatabaseItem;
  image: string;
  yes?: boolean;
  /** Prompt for nested restore; flat destinations use confirmOrYes with this message. */
  confirmMessage: string;
};

export type PrepareRestoreDestinationResult =
  | { cancelled: true }
  | { destDb: ResolvedDb; intoExisting: boolean };

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

/** Shared flat + nested destination prep for restore and dump-restore flows. */
export async function prepareRestoreDestination(
  opts: PrepareRestoreDestinationOpts,
): Promise<PrepareRestoreDestinationResult> {
  const { config, session, destItem, image, yes, confirmMessage } = opts;

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

    const action = await selectNestedRestoreAction(confirmMessage, childExists);
    if (action === "no") {
      return { cancelled: true };
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
        return {
          destDb: { ...destItem, user: parentDb.user, password: parentDb.password },
          intoExisting: false,
        };
      }

      const childKey = dbKey(destItem.key);
      const saved =
        session && config.rememberPassword
          ? await getDbPassword(session, childKey)
          : null;
      const pwSource = yes
        ? "parent"
        : await selectNestedCreatePassword({ hasSaved: Boolean(saved) });

      if (pwSource === "parent") {
        return {
          destDb: { ...destItem, user: parentDb.user, password: parentDb.password },
          intoExisting: false,
        };
      }
      if (pwSource === "saved") {
        if (!saved) throw new Error(`No saved password for "${destItem.key}"`);
        return {
          destDb: { ...destItem, password: saved },
          intoExisting: false,
        };
      }

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
      p.log.success(`Login "${destItem.user}" ready`);
      return {
        destDb: { ...destItem, password },
        intoExisting: false,
      };
    }

    return {
      destDb: { ...destItem, user: parentDb.user, password: parentDb.password },
      intoExisting: true,
    };
  }

  const destDb = await resolveConnectedDb({
    config,
    session,
    item: destItem,
    role: "destination",
    maintenance: true,
  });
  const { created } = await ensureDestDatabase(config, destDb, destItem.key, yes);

  const confirmed = await confirmOrYes(confirmMessage, yes, false);
  if (!confirmed) {
    return { cancelled: true };
  }

  return { destDb, intoExisting: !created };
}
