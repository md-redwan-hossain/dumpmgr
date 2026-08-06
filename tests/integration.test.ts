import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { access, mkdir } from "node:fs/promises";
import { createDatabase, dumpDatabase, restoreDatabase } from "../src/docker.ts";
import { withTempDir } from "./helpers.ts";

let dockerAvailable = true;
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
} catch {
  dockerAvailable = false;
}

test("dumps a real database and restores it into a new database", {
  timeout: 180_000,
  skip: dockerAvailable ? false : "Docker is unavailable",
}, async () => {
    const postgres = await new PostgreSqlContainer("postgres:18")
      .withDatabase("source_db")
      .withUsername("dumpmgr")
      .withPassword("dumpmgr-password")
      .withNetworkAliases("dumpmgr-postgres")
      .start();
    const network = postgres.getNetworkNames()[0];
    assert.ok(network, "Testcontainers did not expose a Docker network");
    process.env.DUMPMGR_DOCKER_NETWORK = network;

    try {
      const source = {
        key: "source",
        host: "dumpmgr-postgres",
        port: 5432,
        user: "dumpmgr",
        database: "source_db",
        nested: false,
        password: "dumpmgr-password",
      };
      const destination = { ...source, key: "destination", database: "restored_db" };

      const setup = await postgres.exec([
        "psql",
        "-U",
        "dumpmgr",
        "-d",
        "source_db",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "CREATE TABLE widgets (id integer PRIMARY KEY, name text); INSERT INTO widgets VALUES (1, 'testcontainers');",
      ]);
      assert.equal(setup.exitCode, 0);

      await withTempDir(async (directory) => {
        await mkdir(`${directory}/dumps`);
        await createDatabase("postgres:18", destination, {
          connectDatabase: "postgres",
        });
        await dumpDatabase("postgres:18", source, directory, "source.dump");
        await access(`${directory}/source.dump`);
        const restored = await restoreDatabase(
          "postgres:18",
          destination,
          directory,
          "source.dump",
        );
        assert.deepEqual(restored, {});

        const verify = await postgres.exec([
          "psql",
          "-U",
          "dumpmgr",
          "-d",
          "restored_db",
          "-tAc",
          "SELECT name FROM widgets WHERE id = 1",
        ]);
        assert.equal(verify.exitCode, 0);
        assert.equal(verify.output.trim(), "testcontainers");
      });
    } finally {
      delete process.env.DUMPMGR_DOCKER_NETWORK;
      await postgres.stop();
    }
});
