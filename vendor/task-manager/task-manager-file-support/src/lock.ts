import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileTaskSpaceError } from './errors.js';
import { assertRegularFile, fsyncDirectory } from './layout.js';

export interface FileTaskSpaceLockOptions {
  readonly lockTimeoutMs: number;
  readonly retryDelayMs: number;
  readonly malformedLockStaleMs: number;
}

interface LockFile {
  readonly kind: 'task-space-lock';
  readonly token: string;
  readonly pid: number;
  readonly acquiredAtMs: number;
}

export interface HeldFileTaskSpaceLock {
  readonly file: string;
  readonly token: string;
  readonly dev: number;
  readonly ino: number;
}

interface ObservedLock extends LockFile {
  readonly file: string;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

export async function acquireFileTaskSpaceLock(
  file: string,
  options: FileTaskSpaceLockOptions,
): Promise<HeldFileTaskSpaceLock> {
  const deadline = Date.now() + options.lockTimeoutMs;
  while (true) {
    const token = randomUUID();
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        const body: LockFile = { kind: 'task-space-lock', token, pid: process.pid, acquiredAtMs: Date.now() };
        fs.writeFileSync(fd, JSON.stringify(body));
        fs.fsyncSync(fd);
        const stat = fs.fstatSync(fd);
        fsyncDirectory(path.dirname(file));
        return { file, token, dev: stat.dev, ino: stat.ino };
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
    }

    const observed = observeLock(file, options.malformedLockStaleMs);
    if (observed && isAbandoned(observed, options.malformedLockStaleMs)) {
      claimAbandonedLock(observed);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new FileTaskSpaceError('lock-timeout', `timed out acquiring ${file}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, options.retryDelayMs));
  }
}

export function releaseFileTaskSpaceLock(lock: HeldFileTaskSpaceLock): void {
  if (!fs.existsSync(lock.file)) return;
  const observed = observeLock(lock.file, 0);
  if (!observed
    || observed.token !== lock.token
    || observed.dev !== lock.dev
    || observed.ino !== lock.ino) return;
  fs.unlinkSync(lock.file);
  fsyncDirectory(path.dirname(lock.file));
}

function observeLock(file: string, malformedLockStaleMs: number): ObservedLock | undefined {
  if (!fs.existsSync(file)) return undefined;
  assertRegularFile(file);
  const stat = fs.lstatSync(file);
  let parsed: Partial<LockFile>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockFile>;
  } catch {
    if (Date.now() - stat.mtimeMs >= malformedLockStaleMs) {
      return {
        kind: 'task-space-lock',
        token: `malformed-${stat.ino}`,
        pid: -1,
        acquiredAtMs: stat.mtimeMs,
        file,
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
      };
    }
    throw new FileTaskSpaceError('lock-corrupt', `${file} contains a live malformed lock`);
  }
  if (parsed.kind !== 'task-space-lock'
    || typeof parsed.token !== 'string'
    || !Number.isSafeInteger(parsed.pid)
    || typeof parsed.acquiredAtMs !== 'number') {
    if (Date.now() - stat.mtimeMs < malformedLockStaleMs) {
      throw new FileTaskSpaceError('lock-corrupt', `${file} contains an invalid live lock`);
    }
  }
  return {
    kind: 'task-space-lock',
    token: parsed.token ?? `malformed-${stat.ino}`,
    pid: parsed.pid ?? -1,
    acquiredAtMs: parsed.acquiredAtMs ?? stat.mtimeMs,
    file,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
  };
}

function isAbandoned(lock: ObservedLock, malformedLockStaleMs: number): boolean {
  if (lock.pid <= 0) return Date.now() - lock.mtimeMs >= malformedLockStaleMs;
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch (error) {
    return isCode(error, 'ESRCH');
  }
}

function claimAbandonedLock(observed: ObservedLock): void {
  const quarantine = `${observed.file}.recover-${randomUUID()}`;
  try {
    fs.renameSync(observed.file, quarantine);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return;
    throw error;
  }
  fsyncDirectory(path.dirname(observed.file));
  assertRegularFile(quarantine);
  const claimed = fs.lstatSync(quarantine);
  if (claimed.dev !== observed.dev || claimed.ino !== observed.ino) {
    throw new FileTaskSpaceError('lock-corrupt', 'abandoned lock inode changed during atomic claim');
  }
  fs.unlinkSync(quarantine);
  fsyncDirectory(path.dirname(observed.file));
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}
