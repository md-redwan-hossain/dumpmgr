import { describe, expect, test } from "bun:test";
import {
  AutonomousOptionsSchema,
  AutonomousScheduleSchema,
  ConfigSchema,
} from "../src/config.ts";

describe("autonomous config", () => {
  test("parses schedule with defaults", () => {
    const schedule = AutonomousScheduleSchema.parse({
      cron: "0 2 * * *",
    });
    expect(schedule.uploadToS3).toBe(false);
    expect(schedule.items).toBeUndefined();
  });

  test("parses full autonomous section", () => {
    const autonomous = AutonomousOptionsSchema.parse({
      schedules: [
        {
          cron: "0 3 * * *",
          items: ["prod"],
          uploadToS3: true,
        },
        {
          cron: "0 */6 * * *",
        },
      ],
    });
    expect(autonomous.schedules).toHaveLength(2);
    expect(autonomous.schedules[0]?.items).toEqual(["prod"]);
  });

  test("rejects empty schedules array", () => {
    const result = AutonomousOptionsSchema.safeParse({ schedules: [] });
    expect(result.success).toBe(false);
  });

  test("config accepts optional autonomous block", () => {
    const config = ConfigSchema.parse({
      autonomous: {
        schedules: [{ cron: "0 1 * * *", uploadToS3: true }],
      },
      items: {
        prod: {
          host: "127.0.0.1",
          port: 5432,
          user: "db_user",
          database: "app_db",
        },
      },
    });
    expect(config.autonomous?.schedules[0]?.cron).toBe("0 1 * * *");
  });
});
