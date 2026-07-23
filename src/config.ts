import { z } from "zod";

export const DatabaseSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  dbname: z.string().min(1),
  password: z.string().min(1).optional(),
});

export type Database = z.infer<typeof DatabaseSchema>;

export const ConfigSchema = z.object({
  image: z.string().default("postgres:18"),
  databases: z
    .record(z.string(), DatabaseSchema)
    .refine((dbs) => Object.keys(dbs).length >= 2, {
      message: "Need at least two databases",
    }),
});

export type Config = z.infer<typeof ConfigSchema>;

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
