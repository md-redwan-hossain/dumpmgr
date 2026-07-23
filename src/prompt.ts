import * as p from "@clack/prompts";
import type { Config, Database } from "./config.ts";

export function onCancel(): never {
  p.cancel("Aborted.");
  process.exit(0);
}

export async function selectDatabase(
  config: Config,
  message: string,
  exclude?: string,
): Promise<{ name: string; db: Database }> {
  const names = Object.keys(config.databases).filter((n) => n !== exclude);
  if (names.length === 0) {
    throw new Error("No databases available to select.");
  }

  const choice = await p.select({
    message,
    options: names.map((name) => {
      const db = config.databases[name]!;
      return {
        value: name,
        label: name,
        hint: `${db.user}@${db.host}:${db.port}/${db.dbname}`,
      };
    }),
  });

  if (p.isCancel(choice)) onCancel();

  return { name: choice, db: config.databases[choice]! };
}

export async function promptPasswordIfMissing(
  label: string,
  db: Database,
): Promise<string> {
  if (db.password) return db.password;

  const pw = await p.password({
    message: `Password for ${label} (${db.user}@${db.host})`,
  });
  if (p.isCancel(pw)) onCancel();
  if (!pw) {
    p.cancel("Password is required.");
    process.exit(1);
  }
  return pw;
}

export async function confirmOrYes(
  message: string,
  yes: boolean,
  initialValue = false,
): Promise<boolean> {
  if (yes) return true;
  const result = await p.confirm({ message, initialValue });
  if (p.isCancel(result)) onCancel();
  return result;
}
