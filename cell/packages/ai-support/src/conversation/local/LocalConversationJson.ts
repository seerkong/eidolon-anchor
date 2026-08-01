import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const pendingWritesByPath = new Map<string, Promise<void>>();

async function performAtomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const writePath = path.resolve(filePath);
  const previous = pendingWritesByPath.get(writePath) ?? Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(() => performAtomicJsonWrite(writePath, value));
  pendingWritesByPath.set(writePath, pending);
  return pending.finally(() => {
    if (pendingWritesByPath.get(writePath) === pending) {
      pendingWritesByPath.delete(writePath);
    }
  });
}

export async function readJsonBestEffort<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
