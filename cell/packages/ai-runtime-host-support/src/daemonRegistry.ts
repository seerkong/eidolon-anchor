import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { constants, mkdirSync, openSync, closeSync, fstatSync, lstatSync } from 'node:fs'
import { realpath, stat, mkdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceRegistration, WorkspaceRegistryStore } from '@cell/ai-runtime-host-contract'

export async function canonicalWorkspace(directory: string) {
  const canonical = await realpath(directory)
  if (!(await stat(canonical)).isDirectory()) throw new Error('workspace_unavailable')
  return canonical
}
export const daemonControlDir = (workspace: string) => join(workspace, '.eidolon', 'projects', 'daemon-control')
export async function ensureDaemonControlDirectory(globalRoot: string) {
  await mkdir(globalRoot, { recursive: true, mode: 0o700 })
  const root = await canonicalWorkspace(globalRoot)
  let directory = root
  for (const name of ['daemon', '.eidolon', 'projects', 'daemon-control']) {
    directory = join(directory, name); await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid() || (info.mode & 0o022) !== 0
      || name === 'daemon-control' && (info.mode & 0o077) !== 0) throw new Error('unsafe_daemon_control_directory')
  }
  return directory
}
export function openDaemonRegistry(directory: string, capacity = 100): WorkspaceRegistryStore {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw new Error('unsafe_daemon_control_directory')
  const filename = join(directory, 'registry.sqlite')
  const descriptor = openSync(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try { const file = fstatSync(descriptor); if (!file.isFile() || (file.mode & 0o077) !== 0 || process.getuid && file.uid !== process.getuid()) throw new Error('unsafe_daemon_registry') }
  finally { closeSync(descriptor) }
  const database = new Database(filename, { strict: true })
  database.exec(`PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS daemon_identity (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS workspaces (workspaceKey TEXT PRIMARY KEY, workspaceId TEXT NOT NULL UNIQUE,
      workDir TEXT NOT NULL, revision INTEGER NOT NULL, placement TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS active_resources (id TEXT PRIMARY KEY, key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS uncertain_resources (key TEXT PRIMARY KEY);`)
  // A preceding parent died before settlement. A restart cannot prove escaped effects have completed.
  database.exec('INSERT OR IGNORE INTO uncertain_resources SELECT key FROM active_resources; DELETE FROM active_resources;')
  database.query('INSERT INTO daemon_identity SELECT ? WHERE NOT EXISTS (SELECT 1 FROM daemon_identity)').run(randomUUID())
  const daemonId = database.query<{ id: string }, []>('SELECT id FROM daemon_identity').get()!.id
  const list = () => database.query<WorkspaceRegistration, []>('SELECT * FROM workspaces ORDER BY workspaceKey').all()
  const register = database.transaction((workDir: string, placement: 'workspace' | 'independent') => {
    const old = database.query<WorkspaceRegistration, [string]>('SELECT * FROM workspaces WHERE workspaceId=?').get(workDir)
    if (old) return old
    if (list().length >= capacity) throw Object.assign(new Error('workspace_capacity'), { status: 429, error: { code: 'workspace_capacity', retryable: false } })
    const value: WorkspaceRegistration = { workspaceKey: randomUUID(), workspaceId: workDir, workDir, placement, revision: 1 }
    database.query('INSERT INTO workspaces VALUES (?,?,?,?,?)').run(value.workspaceKey, workDir, workDir, 1, placement)
    return value
  })
  return { daemonId, list,
    register: async (directory, placement = 'workspace') => register(await canonicalWorkspace(directory), placement),
    remove: key => { database.query('DELETE FROM workspaces WHERE workspaceKey=?').run(key) },
    resources: {
      uncertain: () => database.query<{ key: string }, []>('SELECT key FROM uncertain_resources').all().map(r => r.key),
      acquire: (id, key) => { database.query('INSERT INTO active_resources VALUES (?,?)').run(id, key) },
      release: id => { database.query('DELETE FROM active_resources WHERE id=?').run(id) },
      invalidate: key => { database.query('INSERT OR IGNORE INTO uncertain_resources VALUES (?)').run(key) },
    },
    close: () => database.close(),
  }
}
