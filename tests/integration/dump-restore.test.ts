import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createDatabase,
  dumpDatabase,
  restoreDatabase,
} from "../../src/docker.ts";
import {
  decryptDumpToTemp,
  encryptDumpFile,
  isEncryptedDumpName,
} from "../../src/dumps.ts";
import {
  dockerAvailable,
  execSql,
  type PostgresFixture,
  toResolvedDb,
  withPostgres,
  withTempDir,
} from "./helpers.ts";

const dockerOk = await dockerAvailable();
const describeIntegration = dockerOk ? describe : describe.skip;

async function seedApp(pg: PostgresFixture): Promise<void> {
  await execSql(
    pg,
    [
      "CREATE TABLE IF NOT EXISTS widgets(",
      "  id serial PRIMARY KEY,",
      "  name text NOT NULL",
      ");",
    ].join(" "),
  );
  await execSql(pg, "TRUNCATE widgets;");
  await execSql(pg, "INSERT INTO widgets(name) VALUES ('alpha'), ('beta');");
}

describeIntegration("integration: dump and restore", () => {
  test("round-trips data via pg_dump custom format", async () => {
    await withPostgres(async (pg) => {
      await seedApp(pg);

      await withTempDir(async (workdir) => {
        const dumpName = "app.dump";
        const source = toResolvedDb(pg);
        await dumpDatabase(pg.image, source, workdir, dumpName);

        const dumpPath = join(workdir, dumpName);
        expect(await Bun.file(dumpPath).exists()).toBe(true);
        expect(Bun.file(dumpPath).size).toBeGreaterThan(0);

        const targetDb = "app_restored";
        const target = toResolvedDb(pg, targetDb);
        await createDatabase(pg.image, target);
        await restoreDatabase(pg.image, target, workdir, dumpName);

        expect(await execSql(pg, "SELECT count(*) FROM widgets;", targetDb)).toBe(
          "2",
        );
        expect(
          await execSql(
            pg,
            "SELECT string_agg(name, ',' ORDER BY name) FROM widgets;",
            targetDb,
          ),
        ).toBe("alpha,beta");
      });
    });
  });

  test("restores with --clean into an existing database", async () => {
    await withPostgres(async (pg) => {
      await seedApp(pg);

      await withTempDir(async (workdir) => {
        const dumpName = "app.dump";
        await dumpDatabase(pg.image, toResolvedDb(pg), workdir, dumpName);

        const targetDb = "app_clean";
        const target = toResolvedDb(pg, targetDb);
        await createDatabase(pg.image, target);
        await execSql(
          pg,
          "CREATE TABLE widgets(id serial PRIMARY KEY, name text); INSERT INTO widgets(name) VALUES ('stale');",
          targetDb,
        );
        expect(await execSql(pg, "SELECT count(*) FROM widgets;", targetDb)).toBe(
          "1",
        );

        await restoreDatabase(pg.image, target, workdir, dumpName, { clean: true });
        expect(await execSql(pg, "SELECT count(*) FROM widgets;", targetDb)).toBe(
          "2",
        );
      });
    });
  });

  test("restores from an encrypted dump file", async () => {
    await withPostgres(async (pg) => {
      await seedApp(pg);

      await withTempDir(async (workdir) => {
        const plainName = "app.dump";
        await dumpDatabase(pg.image, toResolvedDb(pg), workdir, plainName);
        const plainPath = join(workdir, plainName);

        const key = await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
        const encPath = await encryptDumpFile(plainPath, key, "ITEST01");
        expect(isEncryptedDumpName(encPath.split("/").pop()!)).toBe(true);

        const tempPlain = join(workdir, "decrypted.dump");
        await decryptDumpToTemp(encPath, key, tempPlain);

        const targetDb = "app_enc";
        await createDatabase(pg.image, toResolvedDb(pg, targetDb));
        await restoreDatabase(
          pg.image,
          toResolvedDb(pg, targetDb),
          workdir,
          "decrypted.dump",
        );

        expect(await execSql(pg, "SELECT count(*) FROM widgets;", targetDb)).toBe(
          "2",
        );
      });
    });
  });
});
