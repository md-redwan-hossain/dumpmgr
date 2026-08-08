import { describe, expect, test } from "bun:test";
import {
  configImage,
  configItems,
  configRestoreTreeItems,
  ConfigSchema,
  dbKey,
  defaultConfigScaffold,
  loadConfigAsync,
  validateConfigFile,
  writeConfigAsync,
} from "../src/config.ts";
import { withTempDir } from "./helpers.ts";

describe("config", () => {
  test("flattens nested items and inherits parent connection fields", () => {
    const config = ConfigSchema.parse({
      items: {
        source: {
          host: "db",
          port: 5432,
          user: "admin",
          database: "app",
          items: {
            copy: { database: "app_copy", user: "reader" },
          },
        },
      },
    });

    expect(configItems(config)).toEqual([
      {
        key: "source",
        host: "db",
        port: 5432,
        user: "admin",
        database: "app",
        nested: false,
      },
      {
        key: "source:copy",
        host: "db",
        port: 5432,
        user: "reader",
        database: "app_copy",
        nested: true,
        parentKey: "source",
      },
    ]);
    expect(dbKey("source:copy")).toBe("postgres:source:copy");
  });

  test("keeps readonly parents visible but removes readonly leaves", () => {
    const config = ConfigSchema.parse({
      items: {
        locked: {
          host: "db",
          port: 5432,
          user: "admin",
          database: "app",
          readonly: true,
        },
        tree: {
          host: "db",
          port: 5432,
          user: "admin",
          database: "app",
          readonly: true,
          items: { child: { database: "child" } },
        },
      },
    });

    expect(configRestoreTreeItems(config).map((item) => ({
      key: item.key,
      disabled: item.disabled,
      depth: item.depth,
    }))).toEqual([
      { key: "tree", disabled: true, depth: 0 },
      { key: "tree:child", disabled: undefined, depth: 1 },
    ]);
  });

  test("provides safe defaults and fake scaffold data", () => {
    const empty = ConfigSchema.parse({});
    expect(empty.rememberPassword).toBe(true);
    expect(empty.encryptedDump).toBe(false);
    expect(configImage(empty)).toBe("postgres:18");
    expect(defaultConfigScaffold(false).items).toEqual({});
    expect(Object.keys(defaultConfigScaffold(true).items)).toEqual([
      "prod",
      "local_dev",
    ]);
    expect(defaultConfigScaffold(true).s3Options).toMatchObject({
      endpoint: "http://127.0.0.1:9000",
      accessKey: "minioadmin",
      bucketName: "dumpmgr-demo",
      forcePathStyle: true,
    });
  });

  test("rejects invalid ports and unknown entry fields", () => {
    const result = ConfigSchema.safeParse({
      items: {
        bad: {
          host: "db",
          port: 70000,
          user: "admin",
          database: "app",
          password: "must-not-be-configured",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects encryptedDump without rememberPassword", async () => {
    await withTempDir(async (directory) => {
      const path = `${directory}/config.jsonc`;
      await Bun.write(
        path,
        JSON.stringify({
          rememberPassword: false,
          encryptedDump: true,
          items: {},
        }),
      );
      await expect(loadConfigAsync(path)).rejects.toThrow(/encryptedDump requires rememberPassword/);
      const result = await validateConfigFile(path);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues[0]).toMatch(/encryptedDump requires rememberPassword/);
      }
    });
  });

  test("loads JSONC and returns validation warnings", async () => {
    await withTempDir(async (directory) => {
      const path = `${directory}/config.jsonc`;
      await Bun.write(
        path,
        `{
          // local test config
          "image": "postgres:18-alpine",
          "items": {},
        }`,
      );
      const config = await loadConfigAsync(path);
      expect(configImage(config)).toBe("postgres:18-alpine");
      const result = await validateConfigFile(path);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.warnings).toEqual([
          "no database items configured",
          'image contains "alpine" (postgres:18-alpine)',
          "no database items configured",
        ]);
      }
    });
  });

  test("writes a config that can be loaded again", async () => {
    await withTempDir(async (directory) => {
      const path = `${directory}/config.jsonc`;
      const original = defaultConfigScaffold(true);
      await writeConfigAsync(path, original);
      const loaded = await loadConfigAsync(path);
      expect(loaded.items.local_dev?.items?.dump?.database).toBe("app_db_dump");
    });
  });
});
