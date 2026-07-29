import { resolve } from "node:path";
import * as p from "@clack/prompts";
import {
  configExists,
  defaultConfigScaffold,
  needsMaster,
  writeConfigAsync,
} from "./config.ts";
import {
  changeMasterPassword,
  createMetadataWithMaster,
  emptyMetadata,
  loadMetadata,
  metadataPathForConfig,
  unlockSession,
} from "./metadata.ts";
import { onCancel, promptPassword } from "./prompt.ts";

export type InitOptions = {
  config: string;
  /** When set, skip the fake-data prompt (e.g. missing-config flow or --with-fake-data). */
  withFakeData?: boolean;
};

async function promptNewMasterPair(): Promise<string> {
  const master = await promptPassword(
    "master password (used for remembered DB secrets / dump encryption)",
  );
  const confirm = await promptPassword("confirm master password");
  if (confirm !== master) {
    p.cancel("Master passwords do not match.");
    process.exit(1);
  }
  return master;
}

export async function runInit(opts: InitOptions): Promise<void> {
  const configPath = resolve(opts.config);
  const metaPath = metadataPathForConfig(configPath);

  if (await configExists(configPath)) {
    const overwrite = await p.confirm({
      message: `${configPath} already exists. Overwrite?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite)) onCancel();
    if (!overwrite) {
      p.cancel("Init aborted.");
      process.exit(0);
    }
  }

  let withFakeData = opts.withFakeData;
  if (withFakeData === undefined) {
    const fake = await p.confirm({
      message: "Populate with fake sample database items?",
      initialValue: false,
    });
    if (p.isCancel(fake)) onCancel();
    withFakeData = fake;
  }

  const config = defaultConfigScaffold(withFakeData);
  await writeConfigAsync(configPath, config);

  if (needsMaster(config)) {
    const existing = await loadMetadata(metaPath);
    const hasMaster = Boolean(existing.masterPassword && existing.kdfSalt);

    if (hasMaster) {
      const action = await p.select({
        message: "Existing master password found in metadata",
        options: [
          {
            value: "change",
            label: "Change master password",
          },
          {
            value: "continue",
            label: "Continue with existing master password",
          },
        ],
      });
      if (p.isCancel(action)) onCancel();

      if (action === "continue") {
        p.log.info("Keeping existing master password and saved DB secrets");
      } else {
        const current = await promptPassword("current master password");
        let session;
        try {
          session = await unlockSession(metaPath, current);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          p.cancel(message);
          process.exit(1);
        }
        const next = await promptNewMasterPair();
        await changeMasterPassword(session, next);
        p.log.success("Master password updated");
      }
    } else {
      const master = await promptNewMasterPair();
      await createMetadataWithMaster(metaPath, master);
    }
  } else {
    await emptyMetadata(metaPath);
  }

  p.log.success(`Wrote ${configPath}`);
  if (needsMaster(config)) {
    p.log.success(`metadata ready at ${metaPath}`);
  } else {
    p.log.success(`Wrote ${metaPath}`);
  }
  p.outro(
    withFakeData
      ? "Edit config.jsonc (replace fake hosts/users) before running dumpmgr."
      : "Add database items to config.jsonc, then run dumpmgr.",
  );
}
