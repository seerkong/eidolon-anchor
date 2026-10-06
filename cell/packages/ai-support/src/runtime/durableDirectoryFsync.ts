import { closeSync, fsyncSync, openSync } from "node:fs";
import { open } from "node:fs/promises";

const UNSUPPORTED_DIRECTORY_FSYNC = new Set(["EPERM", "EINVAL", "ENOTSUP", "EISDIR"]);

/** Windows cannot fsync a directory handle. File data is still synced separately. */
export function isDirectoryFsyncUnsupported(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && UNSUPPORTED_DIRECTORY_FSYNC.has(code);
}

export async function fsyncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (!isDirectoryFsyncUnsupported(error)) throw error;
  } finally {
    await handle.close();
  }
}

export function fsyncDirectorySync(directoryPath: string): void {
  const fd = openSync(directoryPath, "r");
  try {
    fsyncSync(fd);
  } catch (error) {
    if (!isDirectoryFsyncUnsupported(error)) throw error;
  } finally {
    closeSync(fd);
  }
}
