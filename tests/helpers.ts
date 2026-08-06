import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTempDir<T>(
  fn: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "dumpmgr-test-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
