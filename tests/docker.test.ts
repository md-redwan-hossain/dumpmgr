import { chmod, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import {
  databaseExists,
  dockerHost,
  restoreJobs,
  setDockerDebug,
  verifyConnection,
} from "../src/docker.ts";
import { withTempDir } from "./helpers.ts";

describe("docker helpers", () => {
  test("rewrites loopback hosts for Docker Desktop", () => {
    expect(dockerHost("localhost")).toBe("host.docker.internal");
    expect(dockerHost("127.0.0.1")).toBe("host.docker.internal");
    expect(dockerHost("::1")).toBe("host.docker.internal");
    expect(dockerHost("postgres.internal")).toBe("postgres.internal");
    expect(restoreJobs()).toBeGreaterThanOrEqual(1);
  });

  test("runs connection checks without exposing passwords in debug logs", async () => {
    await withTempDir(async (directory) => {
      const docker = `${directory}/docker`;
      await writeFile(docker, "#!/bin/sh\nprintf '1\\n'\n");
      await chmod(docker, 0o755);

      const oldPath = process.env.PATH;
      process.env.PATH = `${directory}:${oldPath ?? ""}`;
      const logs: string[] = [];
      setDockerDebug(true, (message) => logs.push(message));
      try {
        const db = {
          key: "prod",
          host: "db",
          port: 5432,
          user: "admin",
          database: "app",
          nested: false,
          password: "super-secret",
        };
        await verifyConnection("postgres:18", "source", "prod", db);
        expect(await databaseExists("postgres:18", db)).toBe(true);
        expect(logs.some((line) => line.includes("PGPASSWORD=***"))).toBe(true);
        expect(logs.some((line) => line.includes("super-secret"))).toBe(false);
      } finally {
        setDockerDebug(false);
        process.env.PATH = oldPath;
      }
    });
  });
});
