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
    /** Omit to inherit parent user. */
    user: z.string().min(1).optional(),
    database: z.string().min(1),
  })
  .strict();

export type ChildDatabase = z.infer<typeof ChildDatabaseSchema>;

export const DatabaseEntrySchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    user: z.string().min(1),
    database: z.string().min(1),
    readonly: z.boolean().default(false),
    items: z.record(z.string(), ChildDatabaseSchema).optional(),
  })
  .strict();

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
    out.push({
      key,
      host: entry.host,
      port: entry.port,
      user: entry.user,
      database: entry.database,
      nested: false,
    });
    if (entry.items) {
      for (const [childKey, child] of Object.entries(entry.items)) {
        out.push({
          key: `${key}:${childKey}`,
          host: entry.host,
          port: entry.port,
          user: child.user ?? entry.user,
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

    if (entry.readonly && !hasChildren) continue;

    out.push({
      key,
      host: entry.host,
      port: entry.port,
      user: entry.user,
      database: entry.database,
      nested: false,
      depth: 0,
      disabled: entry.readonly || undefined,
    });

    for (const [childKey, child] of children) {
      out.push({
        key: `${key}:${childKey}`,
        host: entry.host,
        port: entry.port,
        user: child.user ?? entry.user,
        database: child.database,
        nested: true,
        parentKey: key,
        depth: 1,
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
  if (!entry) return null;
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

export async function readJsonFile(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`);
  }
  try {
    return await file.json();
  } catch {
    throw new Error(`Invalid JSON in config file: ${path}`);
  }
}

export async function loadConfigAsync(path: string): Promise<Config> {
  const raw = await readJsonFile(path);
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

/** Format any valid JSON in place (2-space indent + trailing newline). */
export async function lintConfigFile(path: string): Promise<void> {
  const raw = await readJsonFile(path);
  await Bun.write(path, `${JSON.stringify(raw, null, 2)}\n`);
}

export type ConfigValidateResult =
  | { ok: true; config: Config; report: string[]; warnings: string[] }
  | { ok: false; issues: string[] };

export async function validateConfigFile(
  path: string,
): Promise<ConfigValidateResult> {
  let raw: unknown;
  try {
    raw = await readJsonFile(path);
  } catch (err) {
    return {
      ok: false,
      issues: [err instanceof Error ? err.message : String(err)],
    };
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    };
  }

  const config = result.data;
  const report: string[] = [
    `rememberPassword: ${config.rememberPassword}`,
    `encryptedDump: ${config.encryptedDump}`,
    `dumpDirectory: ${config.dumpDirectory}`,
  ];
  const warnings: string[] = [];
  let totalItems = 0;

  for (const engine of ENGINES) {
    const section = config[engine];
    if (!section) continue;

    const image = section.image ?? DEFAULT_IMAGES[engine];
    const entries = Object.entries(section.items);
    const nestedCount = entries.reduce(
      (n, [, e]) => n + Object.keys(e.items ?? {}).length,
      0,
    );
    totalItems += entries.length + nestedCount;

    report.push("");
    report.push(
      `${engine}  image=${image}  parents=${entries.length}  nested=${nestedCount}`,
    );

    if (entries.length === 0) {
      warnings.push(`${engine}: no database items`);
    }
    if (image.toLowerCase().includes("alpine")) {
      warnings.push(`${engine}: image contains "alpine" (${image})`);
    }

    for (const [key, entry] of entries) {
      const ro = entry.readonly ? "  readonly" : "";
      report.push(
        `  ${key} → ${entry.host}:${entry.port}  ${entry.user} / ${entry.database}${ro}`,
      );
      if (entry.items) {
        for (const [childKey, child] of Object.entries(entry.items)) {
          const user = child.user ?? entry.user;
          report.push(
            `    ${key}:${childKey} → ${entry.host}:${entry.port}  ${user} / ${child.database}`,
          );
        }
      }
    }
  }

  if (totalItems === 0) {
    warnings.push("no database items configured in any engine");
  }

  return { ok: true, config, report, warnings };
}
