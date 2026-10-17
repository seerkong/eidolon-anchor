import fs from 'node:fs';
import path from 'node:path';
import type { TaskSpaceId } from 'task-manager-contract';
import { FileTaskSpaceError } from './errors.js';

export interface FileTaskSpaceDiagnosticPaths {
  readonly spaceDir: string;
  readonly headFile: string;
  readonly journalFile: string;
  readonly lockFile: string;
  readonly recordsDir: string;
  readonly treesDir: string;
  readonly receiptsDir: string;
  readonly historyDir: string;
  readonly artifactsDir: string;
  readonly commandsDir: string;
}

export interface PreparedFileTaskSpaceRoot {
  readonly root: string;
  readonly realRoot: string;
  readonly spacesDir: string;
}

export function prepareFileTaskSpaceRoot(root: string): PreparedFileTaskSpaceRoot {
  if (!path.isAbsolute(root)) boundary('FileTaskSpaceOwner root must be absolute');
  fs.mkdirSync(root, { recursive: true });
  assertNotSymlink(root);
  const realRoot = fs.realpathSync(root);
  const spacesDir = path.join(realRoot, 'spaces');
  ensureDirectory(spacesDir, realRoot);
  return { root: realRoot, realRoot, spacesDir };
}

export function diagnosticPaths(
  prepared: PreparedFileTaskSpaceRoot,
  taskSpaceId: TaskSpaceId,
): FileTaskSpaceDiagnosticPaths {
  if (taskSpaceId.length === 0 || taskSpaceId.trim() !== taskSpaceId) boundary('taskSpaceId must be non-empty and trimmed');
  const segment = `space-${encodeURIComponent(taskSpaceId)}`;
  if (segment.includes('/') || segment === '.' || segment === '..') boundary('taskSpaceId cannot form a contained segment');
  const spaceDir = contained(prepared.realRoot, path.join(prepared.spacesDir, segment));
  return {
    spaceDir,
    headFile: path.join(spaceDir, 'head.json'),
    journalFile: path.join(spaceDir, 'transaction.json'),
    lockFile: path.join(spaceDir, '.owner.lock'),
    recordsDir: path.join(spaceDir, 'records'),
    treesDir: path.join(spaceDir, 'trees'),
    receiptsDir: path.join(spaceDir, 'receipts'),
    historyDir: path.join(spaceDir, 'history'),
    artifactsDir: path.join(spaceDir, 'artifacts'),
    commandsDir: path.join(spaceDir, 'commands'),
  };
}

export function ensureTaskSpaceLayout(
  prepared: PreparedFileTaskSpaceRoot,
  paths: FileTaskSpaceDiagnosticPaths,
): void {
  for (const directory of [
    paths.spaceDir,
    paths.recordsDir,
    paths.treesDir,
    paths.receiptsDir,
    paths.historyDir,
    paths.artifactsDir,
    paths.commandsDir,
  ]) ensureDirectory(directory, prepared.realRoot);
}

export function resolveContainedRelative(
  prepared: PreparedFileTaskSpaceRoot,
  paths: FileTaskSpaceDiagnosticPaths,
  relativePath: string,
): string {
  if (path.isAbsolute(relativePath)) boundary(`absolute transaction entry ${relativePath} rejected`);
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    boundary(`unsafe transaction entry ${relativePath}`);
  }
  const resolved = contained(paths.spaceDir, path.resolve(paths.spaceDir, ...segments));
  assertExistingChainNoSymlink(prepared.realRoot, resolved);
  return resolved;
}

export function assertRegularFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) boundary(`${file} is not a regular non-symlink file`);
}

const UNSUPPORTED_DIRECTORY_FSYNC = new Set(['EPERM', 'EINVAL', 'ENOTSUP', 'EISDIR']);

/** Retain the 0.1.5 Windows compatibility while keeping file data synced. */
export function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || !code || !UNSUPPORTED_DIRECTORY_FSYNC.has(code)) throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function ensureDirectory(directory: string, realRoot: string): void {
  const parent = path.dirname(directory);
  if (parent !== directory && !fs.existsSync(parent)) ensureDirectory(parent, realRoot);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory);
    fsyncDirectory(parent);
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) boundary(`${directory} is not a real directory`);
  const real = fs.realpathSync(directory);
  contained(realRoot, real);
}

function assertNotSymlink(target: string): void {
  if (fs.lstatSync(target).isSymbolicLink()) boundary(`${target} must not be a symlink`);
}

function assertExistingChainNoSymlink(root: string, target: string): void {
  contained(root, target);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) boundary(`${current} is a symlink`);
  }
}

function contained(root: string, candidate: string): string {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)) {
    boundary(`${candidate} escapes owner root ${root}`);
  }
  return normalizedCandidate;
}

function boundary(message: string): never {
  throw new FileTaskSpaceError('path-boundary', message);
}
