import { basename } from "node:path";
import { dumpEncIdFromName, isEncryptedDumpName } from "./dumps.ts";
import type { Session } from "./metadata.ts";
import { encId } from "./metadata.ts";
import {
  Action,
  getDumpByPath,
  recordAudit,
  recordRestore,
  registerDump,
  relativeDumpPath,
  sha256File,
  Status,
} from "./vault.ts";

export async function recordDump(
  session: Session | null,
  dumpsRoot: string,
  absPath: string,
  itemKey: string,
): Promise<void> {
  if (!session) return;
  const rel = relativeDumpPath(dumpsRoot, absPath);
  const { hash, size } = await sha256File(absPath);
  const name = basename(absPath);
  const enc = isEncryptedDumpName(name);
  let encIdVal = dumpEncIdFromName(name) ?? "";
  if (!encIdVal) encIdVal = encId(session);
  registerDump(session.db, rel, itemKey, name, hash, size, enc, encIdVal);
  recordAudit(
    session.db,
    Action.Dump,
    Status.Success,
    itemKey,
    rel,
    `sha256=${hash} size=${size}`,
    "",
  );
}

export async function recordRestoreOp(
  session: Session | null,
  dumpsRoot: string,
  absPath: string,
  destKey: string,
  durationMs: number,
  clean: boolean,
  warnings: string,
  restoreErr: Error | null,
): Promise<void> {
  if (!session) return;
  let rel = "";
  try {
    rel = relativeDumpPath(dumpsRoot, absPath);
  } catch {
    rel = basename(absPath);
  }
  let hash = "";
  try {
    const h = await sha256File(absPath);
    hash = h.hash;
  } catch {
    // ignore missing file
  }
  const rec = getDumpByPath(session.db, rel);
  recordRestore(session.db, {
    dumpId: rec?.id ?? null,
    dumpRelativePath: rel,
    dumpSha256: hash,
    destinationKey: destKey,
    durationMs,
    status: restoreErr ? Status.Failure : Status.Success,
    cleanRestore: clean,
    warnings,
    errorMessage: restoreErr?.message ?? "",
  });
  if (restoreErr) {
    recordAudit(session.db, Action.Restore, Status.Failure, rel, destKey, "", restoreErr.message);
  } else {
    recordAudit(
      session.db,
      Action.Restore,
      Status.Success,
      rel,
      destKey,
      `duration_ms=${durationMs} clean=${clean}`,
      "",
    );
  }
}

export function recordSyncAudit(
  session: Session | null,
  sourceKey: string,
  destKey: string,
  dumpRel: string,
  err: Error | null,
): void {
  if (!session) return;
  recordAudit(
    session.db,
    Action.Sync,
    err ? Status.Failure : Status.Success,
    sourceKey,
    destKey,
    dumpRel,
    err?.message ?? "",
  );
}
