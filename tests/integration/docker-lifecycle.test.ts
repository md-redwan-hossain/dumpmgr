import { describe, expect, test } from "bun:test";
import {
  createDatabase,
  databaseExists,
  dropDatabase,
  verifyConnection,
} from "../../src/docker.ts";
import {
  dockerAvailable,
  execSql,
  toResolvedDb,
  withPostgres,
} from "./helpers.ts";

const dockerOk = await dockerAvailable();
const describeIntegration = dockerOk ? describe : describe.skip;

describeIntegration("integration: docker lifecycle", () => {
  test("connects and manages databases through Docker tooling", async () => {
    await withPostgres(async (pg) => {
      const app = toResolvedDb(pg);
      await verifyConnection(pg.image, "source", "app", app);

      expect(await databaseExists(pg.image, app)).toBe(true);
      expect(await databaseExists(pg.image, toResolvedDb(pg, "missing"))).toBe(
        false,
      );

      const target = toResolvedDb(pg, "restore_target");
      expect(await databaseExists(pg.image, target)).toBe(false);

      await createDatabase(pg.image, target);
      expect(await databaseExists(pg.image, target)).toBe(true);

      await execSql(pg, "CREATE TABLE IF NOT EXISTS probe(id int);", "restore_target");
      await execSql(pg, "INSERT INTO probe VALUES (1);", "restore_target");
      expect(await execSql(pg, "SELECT count(*) FROM probe;", "restore_target")).toBe(
        "1",
      );

      await dropDatabase(pg.image, target);
      expect(await databaseExists(pg.image, target)).toBe(false);
    });
  });
});
