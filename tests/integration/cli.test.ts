import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { emptyMetadata } from "../../src/metadata.ts";
import { runDoctor } from "../../src/doctor.ts";
import { loadConfigAsync, validateConfigFile } from "../../src/config.ts";
import {
  dockerAvailable,
  integrationConfig,
  runDumpmgrCli,
  sampleConfig,
  withPostgres,
  withTempDir,
  writeConfigFile,
} from "./helpers.ts";

const dockerOk = await dockerAvailable();
const describeIntegration = dockerOk ? describe : describe.skip;

describeIntegration("integration: CLI commands", () => {
  test("config validate reports a healthy integration config", async () => {
    await withTempDir(async (directory) => {
      const configPath = await writeConfigFile(directory, sampleConfig());
      const result = await validateConfigFile(configPath);
      expect(result.ok).toBe(true);
    });
  });

  test("dumpmgr config validate exits zero via CLI", async () => {
    await withTempDir(async (directory) => {
      const configPath = await writeConfigFile(directory, sampleConfig());
      const result = await runDumpmgrCli([
        "config",
        "validate",
        "-c",
        configPath,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/config ok/i);
    });
  });

  test("doctor passes for docker and writable dumps directory", async () => {
    await withPostgres(async (pg) => {
      await withTempDir(async (directory) => {
        const configPath = await writeConfigFile(directory, {
          ...integrationConfig(pg),
          dumpDirectory: join(directory, "data"),
        });
        await emptyMetadata(join(directory, "metadata"));
        const config = await loadConfigAsync(configPath);
        const report = await runDoctor(config, configPath);
        expect(report.ok).toBe(true);
        expect(report.checks.some((c) => c.name === "docker" && c.ok)).toBe(true);
        expect(report.checks.some((c) => c.name === "dumps-root" && c.ok)).toBe(
          true,
        );
      });
    });
  });

  test("dumpmgr doctor exits zero via CLI", async () => {
    await withPostgres(async (pg) => {
      await withTempDir(async (directory) => {
        const configPath = await writeConfigFile(directory, {
          ...integrationConfig(pg),
          dumpDirectory: join(directory, "data"),
        });
        await emptyMetadata(join(directory, "metadata"));
        const result = await runDumpmgrCli(["doctor", "-c", configPath]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toMatch(/doctor ok/i);
      });
    });
  });
});
