import { describe, expect, test } from "bun:test";
import {
  localPathForS3Object,
  s3ObjectKey,
} from "./s3.ts";

describe("S3 object paths", () => {
  test("uses forward-slash keys relative to the dumps root", () => {
    expect(
      s3ObjectKey("/tmp/dumps", "/tmp/dumps/prod/backup.dump"),
    ).toBe("prod/backup.dump");
  });

  test("rejects uploads outside the dumps root", () => {
    expect(() => s3ObjectKey("/tmp/dumps", "/tmp/backup.dump")).toThrow();
  });

  test("keeps downloaded objects under the dumps root", () => {
    expect(localPathForS3Object("/tmp/dumps", "prod/backup.dump")).toBe(
      "/tmp/dumps/prod/backup.dump",
    );
    expect(() => localPathForS3Object("/tmp/dumps", "../backup.dump")).toThrow();
  });
});
