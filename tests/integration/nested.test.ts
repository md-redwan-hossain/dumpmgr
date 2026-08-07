import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createDatabase,
  dumpDatabase,
  ensureDatabaseLogin,
  restoreDatabase,
} from "../../src/docker.ts";
import {
  dockerAvailable,
  execSql,
  toResolvedDb,
  withPostgres,
  withTempDir,
} from "./helpers.ts";

const dockerOk = await dockerAvailable();
const describeIntegration = dockerOk ? describe : describe.skip;

describeIntegration("integration: nested destination flows", () => {
  test("creates a child login and restores into a new child database", async () => {
    await withPostgres(async (pg) => {
      await execSql(
        pg,
        "CREATE TABLE IF NOT EXISTS items(id serial PRIMARY KEY, label text NOT NULL); TRUNCATE items; INSERT INTO items(label) VALUES ('one');",
      );

      const childDb = "child_app";
      const childUser = "child_user";
      const childPassword = "child-pass";
      const parent = toResolvedDb(pg);

      await createDatabase(pg.image, toResolvedDb(pg, childDb), {
        connectDatabase: pg.database,
      });
      await ensureDatabaseLogin(pg.image, parent, {
        user: childUser,
        password: childPassword,
        database: childDb,
        connectDatabase: pg.database,
      });

      await withTempDir(async (workdir) => {
        const dumpName = "parent.dump";
        await dumpDatabase(pg.image, parent, workdir, dumpName);

        await execSql(pg, "DROP TABLE IF EXISTS items;", childDb);
        await restoreDatabase(
          pg.image,
          {
            ...toResolvedDb(pg, childDb, "parent:child"),
            user: childUser,
            password: childPassword,
          },
          workdir,
          dumpName,
        );

        expect(await execSql(pg, "SELECT count(*) FROM items;", childDb)).toBe("1");
      });
    });
  });
});
