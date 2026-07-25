import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import * as p from "@clack/prompts";
import type { Config, DatabaseItem, Engine, TreeDatabaseOption } from "./config.ts";
import {
  ENGINES,
  engineItemCount,
  engineRestoreTreeItems,
  needsMaster,
} from "./config.ts";
import { listDumpBrowserEntries } from "./dumps.ts";
import type { Session } from "./metadata.ts";
import { getDbPassword, setDbPassword } from "./metadata.ts";

export type Mode =
  | "dump-restore"
  | "dump"
  | "restore"
  | "change-master"
  | "exit";

export function onCancel(): never {
  p.cancel("Aborted.");
  process.exit(0);
}

export async function selectMode(config: Config): Promise<Mode> {
  const options: { value: Mode; label: string; hint?: string }[] = [
    { value: "dump", label: "Take dump", hint: "Write dump file only" },
    {
      value: "restore",
      label: "Restore from dump",
      hint: "Pick a dump file → destination",
    },
    {
      value: "dump-restore",
      label: "Take dump and restore",
      hint: "Copy source → destination",
    },
  ];
  if (needsMaster(config)) {
    options.push({
      value: "change-master",
      label: "Change master password",
      hint: "Rotate master + re-encrypt secrets",
    });
  }
  options.push({ value: "exit", label: "Exit" });

  const choice = await p.select({ message: "What do you want to do?", options });
  if (p.isCancel(choice)) onCancel();
  return choice;
}

export async function selectEngine(config: Config, minItems: number): Promise<Engine> {
  const available = ENGINES.filter((e) => engineItemCount(config, e) >= minItems);
  if (available.length === 0) {
    throw new Error(
      `No engine has at least ${minItems} database item(s). Edit config.json.`,
    );
  }

  const choice = await p.select({
    message: "Select database engine",
    options: available.map((e) => ({
      value: e,
      label: e,
      hint: `${engineItemCount(config, e)} item(s)`,
    })),
  });
  if (p.isCancel(choice)) onCancel();
  return choice;
}

function itemHint(db: DatabaseItem): string {
  return `${db.user}@${db.host}:${db.port}/${db.database}`;
}

export async function selectDatabaseItem(
  items: DatabaseItem[],
  message: string,
  exclude?: string,
): Promise<DatabaseItem> {
  const list = items.filter((i) => i.key !== exclude);
  if (list.length === 0) {
    throw new Error("No databases available to select.");
  }
  const choice = await p.select({
    message,
    options: list.map((db) => ({
      value: db.key,
      label: db.key,
      hint: itemHint(db),
    })),
  });
  if (p.isCancel(choice)) onCancel();
  return list.find((i) => i.key === choice)!;
}

export async function selectDatabaseTree(
  config: Config,
  engine: Engine,
  message: string,
  exclude?: string,
): Promise<DatabaseItem> {
  const tree = engineRestoreTreeItems(config, engine).filter(
    (i) => i.key !== exclude,
  );
  if (tree.length === 0) {
    throw new Error("No databases available to select.");
  }
  const choice = await p.select({
    message,
    options: tree.map((db: TreeDatabaseOption) => {
      const leaf = db.nested ? db.key.split(":").pop()! : db.key;
      const label = db.nested ? `  └ ${leaf}` : leaf;
      return {
        value: db.key,
        label,
        hint: db.disabled ? "readonly" : itemHint(db),
        disabled: db.disabled === true,
      };
    }),
  });
  if (p.isCancel(choice)) onCancel();
  const selected = tree.find((i) => i.key === choice)!;
  if (selected.disabled) {
    throw new Error(`"${selected.key}" is readonly and cannot be a restore destination.`);
  }
  return selected;
}

export async function promptPassword(message: string): Promise<string> {
  const labeled = message.startsWith("Enter ") ? message : `Enter ${message}`;
  const pw = await p.password({ message: labeled });
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

export type NestedRestoreAction = "yes" | "no" | "drop" | "create";

export async function selectNestedRestoreAction(
  message: string,
  childExists: boolean,
): Promise<NestedRestoreAction> {
  const options = childExists
    ? [
        { value: "yes" as const, label: "Yes", hint: "Restore into existing database" },
        {
          value: "drop" as const,
          label: "Drop database and restore",
          hint: "DROP → CREATE → restore",
        },
        { value: "no" as const, label: "No" },
      ]
    : [
        {
          value: "create" as const,
          label: "Create database and restore",
          hint: "CREATE → restore",
        },
        { value: "no" as const, label: "No" },
      ];
  const choice = await p.select({ message, options });
  if (p.isCancel(choice)) onCancel();
  return choice;
}

export async function resolveDbPassword(opts: {
  session: Session | null;
  rememberPassword: boolean;
  engine: Engine;
  item: DatabaseItem;
}): Promise<string> {
  const key = `${opts.engine}:${opts.item.key}`;
  if (opts.rememberPassword && opts.session?.aesKey) {
    const existing = await getDbPassword(opts.session, key);
    if (existing) return existing;
  }

  const pw = await promptPassword(
    `password for ${opts.item.key} (${opts.item.user}@${opts.item.host})`,
  );
  if (opts.rememberPassword && opts.session) {
    await setDbPassword(opts.session, key, pw);
  }
  return pw;
}

export async function connectWithRetry(opts: {
  label: string;
  getPassword: () => Promise<string>;
  setPassword: (pw: string) => Promise<void>;
  connect: (password: string) => Promise<void>;
}): Promise<string> {
  let password = await opts.getPassword();
  for (;;) {
    try {
      await opts.connect(password);
      return password;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(message);
      const action = await p.select({
        message: `Connection failed for ${opts.label}. What next?`,
        options: [
          { value: "retry", label: "Retry" },
          { value: "change", label: "Change password and retry" },
          { value: "abort", label: "Abort" },
        ],
      });
      if (p.isCancel(action) || action === "abort") onCancel();
      if (action === "change") {
        password = await promptPassword(`new password for ${opts.label}`);
        await opts.setPassword(password);
      }
    }
  }
}

/** Interactive dump browser under rootDir. Returns absolute dump file path. */
export async function browseDumpFile(
  rootDir: string,
  encryptedOnly: boolean,
): Promise<string> {
  await mkdir(rootDir, { recursive: true });
  const root = resolve(rootDir);
  let cwd = root;

  for (;;) {
    const rel = relative(root, cwd) || ".";
    const entries = await listDumpBrowserEntries(cwd, encryptedOnly);
    const options: { value: string; label: string; hint?: string }[] = [];

    if (cwd !== root) {
      options.push({ value: "..", label: "..", hint: "Parent folder" });
    }
    for (const e of entries) {
      if (e.kind === "dir") {
        options.push({ value: `dir:${e.name}`, label: `${e.name}/`, hint: "Folder" });
      } else {
        options.push({ value: `file:${e.name}`, label: e.name });
      }
    }

    if (options.length === 0) {
      throw new Error(`No dump files or folders under ${root}`);
    }

    const choice = await p.select({
      message: `Browse dumps (${rel})`,
      options,
    });
    if (p.isCancel(choice)) onCancel();

    if (choice === "..") {
      cwd = dirname(cwd);
      if (!cwd.startsWith(root)) cwd = root;
      continue;
    }
    if (choice.startsWith("dir:")) {
      cwd = join(cwd, choice.slice(4));
      continue;
    }
    if (choice.startsWith("file:")) {
      return join(cwd, choice.slice(5));
    }
  }
}
