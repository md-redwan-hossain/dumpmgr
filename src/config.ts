import { z } from "zod";

export const ENGINES = ["postgres", "mysql", "mariadb"] as const;
export type Engine = (typeof ENGINES)[number];

export const DEFAULT_IMAGES: Record<Engine, string> = {
  postgres: "postgres:18",
  mysql: "mysql:8",
  mariadb: "mariadb:11",
};

export const ChildDatabaseSchema = z
  .object({
    user: z.string().min(1),
    database: z.string().min(1),
  })
  .strict();

export type ChildDatabase = z.infer<typeof ChildDatabaseSchema>;

export const DatabaseEntrySchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    user: z.string().min(1).optional(),
    database: z.string().min(1).optional(),
    readonly: z.boolean().default(false),
    items: z.record(z.string(), ChildDatabaseSchema).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const hasSelf = Boolean(entry.user && entry.database);
    const hasChildren = entry.items && Object.keys(entry.items).length > 0;
    if (!hasSelf && !hasChildren) {
      ctx.addIssue({
        code: "custom",
        message: "Need user+database and/or non-empty items",
      });
    }
    if ((entry.user && !entry.database) || (!entry.user && entry.database)) {
      ctx.addIssue({
        code: "custom",
        message: "user and database must both be set together",
      });
    }
  });

export type DatabaseEntry = z.infer<typeof DatabaseEntrySchema>;

/** Runtime item: object key is `key`; `database` is the DB name on the server. */
export type DatabaseItem = {
  key: string;
  host: string;
  port: number;
  user: string;
  database: string;
  /** True when this is a nested child under a parent connection. */
  nested: boolean;
  /** Parent key when nested; otherwise undefined. */
  parentKey?: string;
};

export const EngineSectionSchema = z.object({
  image: z.string().min(1).optional(),
  items: z.record(z.string(), DatabaseEntrySchema).default({}),
});

export type EngineSection = z.infer<typeof EngineSectionSchema>;

export const ConfigSchema = z
  .object({
    rememberPassword: z.boolean().default(true),
    encryptedDump: z.boolean().default(false),
    dumpDirectory: z.string().default("."),
    postgres: EngineSectionSchema.optional(),
    mysql: EngineSectionSchema.optional(),
    mariadb: EngineSectionSchema.optional(),
  })
  .refine((c) => c.postgres || c.mysql || c.mariadb, {
    message: "Need at least one of postgres, mysql, mariadb",
  });

export type Config = z.infer<typeof ConfigSchema>;

export function needsMaster(config: Config): boolean {
  return config.rememberPassword || config.encryptedDump;
}

export function engineImage(config: Config, engine: Engine): string {
  return config[engine]?.image ?? DEFAULT_IMAGES[engine];
}

export function engineItems(config: Config, engine: Engine): DatabaseItem[] {
  const entries = config[engine]?.items ?? {};
  const out: DatabaseItem[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.user && entry.database) {
      out.push({
        key,
        host: entry.host,
        port: entry.port,
        user: entry.user,
        database: entry.database,
        nested: false,
      });
    }
    if (entry.items) {
      for (const [childKey, child] of Object.entries(entry.items)) {
        out.push({
          key: `${key}:${childKey}`,
          host: entry.host,
          port: entry.port,
          user: child.user,
          database: child.database,
          nested: true,
          parentKey: key,
        });
      }
    }
  }
  return out;
}

/** Entries for tree UI: parents and nested children with display depth. */
export type TreeDatabaseOption = DatabaseItem & {
  depth: number;
  /** Visible but not choosable (readonly parent). */
  disabled?: boolean;
};

/** Destination picker: readonly parents stay visible but disabled. */
export function engineRestoreTreeItems(
  config: Config,
  engine: Engine,
): TreeDatabaseOption[] {
  const entries = config[engine]?.items ?? {};
  const out: TreeDatabaseOption[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    const children = entry.items ? Object.entries(entry.items) : [];
    const hasChildren = children.length > 0;
    const hasSelf = Boolean(entry.user && entry.database);

    if (entry.readonly && !hasChildren) continue;

    if (hasSelf) {
      out.push({
        key,
        host: entry.host,
        port: entry.port,
        user: entry.user!,
        database: entry.database!,
        nested: false,
        depth: 0,
        disabled: entry.readonly || undefined,
      });
    } else if (entry.readonly && hasChildren) {
      // Connection-only readonly parent: still show a disabled header
      out.push({
        key,
        host: entry.host,
        port: entry.port,
        user: children[0]![1].user,
        database: "(readonly)",
        nested: false,
        depth: 0,
        disabled: true,
      });
    }

    for (const [childKey, child] of children) {
      out.push({
        key: `${key}:${childKey}`,
        host: entry.host,
        port: entry.port,
        user: child.user,
        database: child.database,
        nested: true,
        parentKey: key,
        depth: hasSelf || entry.readonly ? 1 : 0,
      });
    }
  }
  return out;
}

export function engineItemCount(config: Config, engine: Engine): number {
  return engineItems(config, engine).length;
}

export function getParentItem(
  config: Config,
  engine: Engine,
  parentKey: string,
): DatabaseItem | null {
  const entry = config[engine]?.items?.[parentKey];
  if (!entry?.user || !entry.database) return null;
  return {
    key: parentKey,
    host: entry.host,
    port: entry.port,
    user: entry.user,
    database: entry.database,
    nested: false,
  };
}

export function dbKey(engine: Engine, itemKey: string): string {
  return `${engine}:${itemKey}`;
}

function entry(
  fields: Omit<DatabaseEntry, "readonly"> & { readonly?: boolean },
): DatabaseEntry {
  return { readonly: false, ...fields };
}

export function defaultConfigScaffold(withFakeData: boolean): Config {
  const empty = { items: {} as Record<string, DatabaseEntry> };
  if (!withFakeData) {
    return {
      rememberPassword: true,
      encryptedDump: false,
      dumpDirectory: ".",
      postgres: { image: DEFAULT_IMAGES.postgres, ...empty },
      mysql: { image: DEFAULT_IMAGES.mysql, ...empty },
      mariadb: { image: DEFAULT_IMAGES.mariadb, ...empty },
    };
  }
  return {
    rememberPassword: true,
    encryptedDump: false,
    dumpDirectory: ".",
    postgres: {
      image: DEFAULT_IMAGES.postgres,
      items: {
        prod: entry({
          host: "127.0.0.1",
          port: 5432,
          user: "db_user",
          database: "app_db",
        }),
        local_dev: entry({
          host: "localhost",
          port: 5433,
          user: "db_user",
          database: "app_db",
          items: {
            dump: {
              user: "db_user",
              database: "app_db_dump",
            },
          },
        }),
      },
    },
    mysql: {
      image: DEFAULT_IMAGES.mysql,
      items: {
        local: entry({
          host: "localhost",
          port: 3306,
          user: "root",
          database: "app",
        }),
      },
    },
    mariadb: {
      image: DEFAULT_IMAGES.mariadb,
      items: {
        local: entry({
          host: "localhost",
          port: 3307,
          user: "root",
          database: "app",
        }),
      },
    },
  };
}

export async function configExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

export async function loadConfigAsync(path: string): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`);
  }

  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    throw new Error(`Invalid JSON in config file: ${path}`);
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config (${path}):\n${details}`);
  }

  return result.data;
}

export async function writeConfigAsync(
  path: string,
  config: Config,
): Promise<void> {
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
}
