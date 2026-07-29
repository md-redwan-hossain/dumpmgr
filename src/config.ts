import { z } from "zod";
import { parse, stringify } from "comment-json";

export const DEFAULT_IMAGE = "postgres:18";

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

export const ConfigSchema = z.object({
  rememberPassword: z.boolean().default(true),
  encryptedDump: z.boolean().default(false),
  dumpDirectory: z.string().default("."),
  image: z.string().min(1).optional(),
  items: z.record(z.string(), DatabaseEntrySchema).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export function needsMaster(config: Config): boolean {
  return config.rememberPassword || config.encryptedDump;
}

export function configImage(config: Config): string {
  return config.image ?? DEFAULT_IMAGE;
}

export function configItems(config: Config): DatabaseItem[] {
  const entries = config.items ?? {};
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
export function configRestoreTreeItems(config: Config): TreeDatabaseOption[] {
  const entries = config.items ?? {};
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

export function configItemCount(config: Config): number {
  return configItems(config).length;
}

export function getParentItem(
  config: Config,
  parentKey: string,
): DatabaseItem | null {
  const entry = config.items?.[parentKey];
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

export function dbKey(itemKey: string): string {
  return `postgres:${itemKey}`;
}

function entry(
  fields: Omit<DatabaseEntry, "readonly"> & { readonly?: boolean },
): DatabaseEntry {
  return { readonly: false, ...fields };
}

export function defaultConfigScaffold(withFakeData: boolean): Config {
  if (!withFakeData) {
    return {
      rememberPassword: true,
      encryptedDump: false,
      dumpDirectory: ".",
      image: DEFAULT_IMAGE,
      items: {},
    };
  }
  return {
    rememberPassword: true,
    encryptedDump: false,
    dumpDirectory: ".",
    image: DEFAULT_IMAGE,
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
  };
}

export const DEFAULT_CONFIG_PATH = "config.jsonc";

export async function configExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

export async function readConfigFile(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`);
  }
  try {
    return parse(await file.text());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSONC in config file: ${path}\n${detail}`);
  }
}

export async function loadConfigAsync(path: string): Promise<Config> {
  const raw = await readConfigFile(path);
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
  await Bun.write(path, `${stringify(config, null, 2)}\n`);
}

/** Format config in place (2-space indent). Comments are preserved. */
export async function lintConfigFile(path: string): Promise<void> {
  const raw = await readConfigFile(path);
  await Bun.write(path, `${stringify(raw, null, 2)}\n`);
}

export type ConfigValidateResult =
  | { ok: true; config: Config; report: string[]; warnings: string[] }
  | { ok: false; issues: string[] };

export async function validateConfigFile(
  path: string,
): Promise<ConfigValidateResult> {
  let raw: unknown;
  try {
    raw = await readConfigFile(path);
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
  const image = configImage(config);
  const entries = Object.entries(config.items);
  const nestedCount = entries.reduce(
    (n, [, e]) => n + Object.keys(e.items ?? {}).length,
    0,
  );
  const totalItems = entries.length + nestedCount;

  const report: string[] = [
    `rememberPassword: ${config.rememberPassword}`,
    `encryptedDump: ${config.encryptedDump}`,
    `dumpDirectory: ${config.dumpDirectory}`,
    "",
    `image=${image}  parents=${entries.length}  nested=${nestedCount}`,
  ];
  const warnings: string[] = [];

  if (entries.length === 0) {
    warnings.push("no database items configured");
  }
  if (image.toLowerCase().includes("alpine")) {
    warnings.push(`image contains "alpine" (${image})`);
  }

  for (const [key, e] of entries) {
    const ro = e.readonly ? "  readonly" : "";
    report.push(
      `  ${key} → ${e.host}:${e.port}  ${e.user} / ${e.database}${ro}`,
    );
    if (e.items) {
      for (const [childKey, child] of Object.entries(e.items)) {
        const user = child.user ?? e.user;
        report.push(
          `    ${key}:${childKey} → ${e.host}:${e.port}  ${user} / ${child.database}`,
        );
      }
    }
  }

  if (totalItems === 0) {
    warnings.push("no database items configured");
  }

  return { ok: true, config, report, warnings };
}
