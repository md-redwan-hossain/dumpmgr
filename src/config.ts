import { z } from "zod";

export const ENGINES = ["postgres", "mysql", "mariadb"] as const;
export type Engine = (typeof ENGINES)[number];

export const DEFAULT_IMAGES: Record<Engine, string> = {
  postgres: "postgres:18",
  mysql: "mysql:8",
  mariadb: "mariadb:11",
};

export const DatabaseFieldsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  name: z.string().min(1),
});

export type DatabaseFields = z.infer<typeof DatabaseFieldsSchema>;

/** Runtime item: object key is `key`; `name` is the database name on the server. */
export type DatabaseItem = DatabaseFields & { key: string };

export const EngineSectionSchema = z.object({
  image: z.string().min(1).optional(),
  items: z.record(z.string(), DatabaseFieldsSchema).default({}),
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
  const items = config[engine]?.items ?? {};
  return Object.entries(items).map(([key, fields]) => ({ key, ...fields }));
}

export function engineItemCount(config: Config, engine: Engine): number {
  return Object.keys(config[engine]?.items ?? {}).length;
}

export function dbKey(engine: Engine, itemKey: string): string {
  return `${engine}:${itemKey}`;
}

export function defaultConfigScaffold(withFakeData: boolean): Config {
  const empty = { items: {} as Record<string, DatabaseFields> };
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
        prod: {
          host: "127.0.0.1",
          port: 5432,
          user: "db_user",
          name: "app_db",
        },
        staging: {
          host: "localhost",
          port: 5433,
          user: "db_user",
          name: "app_db",
        },
      },
    },
    mysql: {
      image: DEFAULT_IMAGES.mysql,
      items: {
        local: {
          host: "localhost",
          port: 3306,
          user: "root",
          name: "app",
        },
      },
    },
    mariadb: {
      image: DEFAULT_IMAGES.mariadb,
      items: {
        local: {
          host: "localhost",
          port: 3307,
          user: "root",
          name: "app",
        },
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
