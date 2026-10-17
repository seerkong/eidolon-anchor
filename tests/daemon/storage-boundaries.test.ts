import { expect, test } from 'bun:test'
import { symlink, readdir, mkdir, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { openDaemonRegistry, daemonControlDir, ensureDaemonControlDirectory } from '../../cell/packages/ai-runtime-host-support/src/daemonRegistry'
import { createDaemon } from '../../cell/packages/ai-runtime-host-capsule/src/daemon'
import { LocalFilePermissionConfigStore } from '../../cell/packages/ai-support/src/permissions/LocalFilePermissionConfigStore'
import { fixture, workerCommand } from './helpers'
import { loadPhysicalEidolonDirectoryOverlay } from '../../cell/packages/symbiont-logic/src/resource/EffectiveEidolonVfsMaterializer'
import { isProtectedPermissionConfigPath } from '../../cell/packages/ai-organ-logic/src/permissions/LocalPermissionEvaluator'
import { createDaemonResourceEffects } from '../../cell/packages/ai-runtime-host-support/src/daemonResource'
import { configureLocalPermissionConfigStore } from '../../cell/packages/ai-organ-logic/src/permissions/LocalPermissionConfig'
import { authorizeLocalToolCall } from '../../cell/packages/ai-organ-logic/src/permissions/LocalPermissionRuntime'
import { readCoreLogic } from '../../cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Read/Logic'
import { bashCoreLogic } from '../../cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Bash/Logic'
import { privateReadExecutionBoundary, resolveSandboxBackendSelectionFromRuntime } from '../../cell/packages/ai-organ-logic/src/sandbox/SandboxBackendRuntime'
import { createActor, createVM } from '@cell/ai-core-logic'

test('canonical registry persists stable keys; global daemon is a separate independent workspace', async () => {
  const f = await fixture()
  let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined
  try {
    const alias = join(f.root, 'alias'); await symlink(f.a, alias)
    const directory = daemonControlDir(join(f.globalRoot, 'daemon'))
    const registry = openDaemonRegistry(directory), a = await registry.register(f.a), daemonId = registry.daemonId
    expect((await registry.register(alias)).workspaceKey).toBe(a.workspaceKey)
    registry.close()
    daemon = await createDaemon({ globalRoot: f.globalRoot, workerCommand })
    expect(daemon.capabilities().daemonId).toBe(daemonId)
    expect(daemon.workspaces().find(w => w.workspaceKey === a.workspaceKey)?.workDir).toBe(f.a)
    expect(daemon.workspaces().find(w => w.workspaceKey === daemon!.capabilities().globalWorkspaceKey)).toMatchObject({ workDir: join(f.globalRoot, 'daemon'), placement: 'independent', state: 'registered' })
    expect(await readdir(f.a)).toEqual([])
    expect(LocalFilePermissionConfigStore.protectedPermissionConfigPaths(f.globalRoot)).toContain(directory)
    await expect(daemon.register(f.globalRoot)).rejects.toThrow('reserved_workspace')
    expect(() => daemon!.remove(daemon!.capabilities().globalWorkspaceKey)).toThrow('global_workspace_required')
  } finally { await daemon?.close(); await f.cleanup() }
})

test('home VFS excludes daemon/control storage; permission authority protects its entire private namespace', async () => {
  const f = await fixture()
  try {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore)
    const directory = daemonControlDir(join(f.globalRoot, 'daemon'))
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'bearer'), 'private-daemon-credential')
    await mkdir(join(f.globalRoot, 'web-host')); await writeFile(join(f.globalRoot, 'web-host', 'host.db'), 'private-host-database')
    await mkdir(join(f.globalRoot, '.writer-locks')); await writeFile(join(f.globalRoot, '.writer-locks', 'lease.sqlite'), 'private-writer-lease')
    const overlay = await loadPhysicalEidolonDirectoryOverlay({ id: 'home', kind: 'home', order: 0, rootDir: f.globalRoot })
    expect(JSON.stringify(overlay.intent.snapshot)).not.toMatch(/private-daemon-credential|private-host-database|daemon-control|private-writer-lease/)
    expect(isProtectedPermissionConfigPath(join(directory, 'bearer'), f.globalRoot)).toBe(true)
    expect(isProtectedPermissionConfigPath(join(directory, 'registry.sqlite-wal'), f.globalRoot)).toBe(true)
    await symlink(directory, join(f.a, 'control-alias'))
    expect(isProtectedPermissionConfigPath(join(f.a, 'control-alias', 'bearer'), f.globalRoot)).toBe(true)
    expect(isProtectedPermissionConfigPath(join(f.globalRoot, 'daemon', '.eidolon', 'sessions', 'history.json'), f.globalRoot)).toBe(false)
  } finally { await f.cleanup() }
})

test('write-ahead uncertain effects remain quarantined after daemon restart', async () => {
  const f = await fixture()
  try {
    const directory = daemonControlDir(join(f.globalRoot, 'daemon'))
    let registry = openDaemonRegistry(directory)
    registry.resources.acquire('crashed-effect', f.a); registry.close()
    registry = openDaemonRegistry(directory)
    const arbiter = createDaemonResourceEffects(registry.resources)
    try {
      await expect(arbiter.acquire({ workDir: f.a, kind: 'workspace_mutation' })).rejects.toThrow('resource_effect_unsettled')
      ;(await arbiter.acquire({ workDir: f.b, kind: 'workspace_mutation' })).release()
      expect(registry.resources.uncertain()).toContain(f.a)
    } finally { arbiter.close(); registry.close() }
  } finally { await f.cleanup() }
})

test('control storage rejects symlinked directories and public database permissions before startup', async () => {
  const f = await fixture()
  try {
    await symlink(f.a, join(f.globalRoot, 'daemon'))
    await expect(ensureDaemonControlDirectory(f.globalRoot)).rejects.toThrow('unsafe_daemon_control_directory')
    const other = join(f.root, 'private-global')
    const directory = await ensureDaemonControlDirectory(other)
    const database = join(directory, 'registry.sqlite')
    await writeFile(database, '', { mode: 0o644 })
    expect(() => openDaemonRegistry(directory)).toThrow('unsafe_daemon_registry')
    await chmod(database, 0o600)
    const registry = openDaemonRegistry(directory); registry.close()
    await chmod(directory, 0o755)
    await expect(ensureDaemonControlDirectory(other)).rejects.toThrow('unsafe_daemon_control_directory')
    expect(() => openDaemonRegistry(directory)).toThrow('unsafe_daemon_control_directory')
  } finally { await f.cleanup() }
})

test('actual Read and Bash permission ingress cannot expose control data even in trusted execution modes', async () => {
  const f = await fixture()
  try {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore)
    const directory = await ensureDaemonControlDirectory(f.globalRoot)
    await writeFile(join(directory, 'bearer'), 'ISOLATED_PRIVATE_CONTROL_SECRET', { mode: 0o600 })
    await writeFile(join(f.globalRoot, 'permissions.json'), JSON.stringify({ permission: { bash: 'allow' } }))
    await symlink(directory, join(f.a, 'control-alias'))
    for (const mode of ['default', 'interactive', 'full-auto', 'dangerous']) {
      for (const [workDir, filePath] of [[join(f.globalRoot, 'daemon'), '.eidolon/projects/daemon-control/bearer'], [f.a, 'control-alias/bearer']]) {
        const actor = createActor({ key: 'main', id: 'read-boundary' })
        const vm = createVM({ controlActorKey: 'main', actors: { main: actor }, outerCtx: { workDir, metadata: { local_permissions: { authority_root: f.globalRoot }, exec_protocol: { mode } } } })
        const runtime = { vm, actor } as Parameters<typeof readCoreLogic>[0]
        const output = await readCoreLogic(runtime, { filePath }, {})
        expect(output).toContain('Private runtime control data')
        expect(output).not.toContain('ISOLATED_PRIVATE_CONTROL_SECRET')
        expect(authorizeLocalToolCall(runtime, 'bash', { command: `cat ${filePath}` }).ok).toBe(false)
        expect(authorizeLocalToolCall(runtime, 'read', { filePath: 'safe.txt' }).ok).toBe(true)
        await writeFile(join(workDir, 'safe.txt'), 'PUBLIC_CONTROL_BOUNDARY_PROBE')
        const bashOutput = await bashCoreLogic(runtime as Parameters<typeof bashCoreLogic>[0], { command: 'rg -uuu -L "ISOLATED_PRIVATE_CONTROL_SECRET|PUBLIC_CONTROL_BOUNDARY_PROBE" .' }, {})
        if (privateReadExecutionBoundary(resolveSandboxBackendSelectionFromRuntime(runtime, workDir))) {
          // Recursive search may execute only when the actual child enforces
          // the private read denial. Public siblings must remain readable.
          expect(typeof bashOutput).toBe('object')
          const result = bashOutput as { output: string; outcome: { status: string } }
          expect(result.output).toContain('PUBLIC_CONTROL_BOUNDARY_PROBE')
          expect(result.outcome.status).toBe('failed')
          expect(result.output).not.toContain('ISOLATED_PRIVATE_CONTROL_SECRET')
        } else {
          expect(bashOutput).toContain('Private runtime control data')
          expect(bashOutput).not.toContain('ISOLATED_PRIVATE_CONTROL_SECRET')
        }
      }
    }
    const runtime = { vm: { outerCtx: { workDir: join(f.globalRoot, 'daemon'), metadata: { local_permissions: { authority_root: f.globalRoot } } } } }
    expect(authorizeLocalToolCall(runtime, 'grep', { path: '.eidolon/projects', pattern: 'PRIVATE' }).ok).toBe(false)
    expect(authorizeLocalToolCall(runtime, 'glob', { path: '.eidolon/projects', pattern: '**/*' }).ok).toBe(false)
    expect(authorizeLocalToolCall(runtime, 'bash', { command: 'cat .eidolon/projects/*/bearer' }).ok).toBe(false)
    expect(authorizeLocalToolCall(runtime, 'bash', { command: 'grep -R PRIVATE .' }).ok).toBe(false)
    for (const mode of ['default', 'dangerous', 'full-auto']) {
      const guarded = { vm: { outerCtx: { ...runtime.vm.outerCtx, metadata: { ...runtime.vm.outerCtx.metadata, exec_protocol: { mode } } } } }
      for (const payload of [
        { command: 'rg --hidden PRIVATE' }, { command: 'grep -R PRIVATE' },
        { command: 'grep -Rn PRIVATE' }, { command: 'grep -rI PRIVATE .' }, { command: 'rg -uuu PRIVATE' },
        { command: 'cat bearer', workdir: '.eidolon/projects/daemon-control' },
        { command: 'cat daemon-control/bearer', workdir: '.eidolon/projects' },
        { command: 'cd .eidolon/projects; cat daemon-control/bearer' },
        { command: 'python3 -c \'print(open(".eidolon/projects/daemon-control/bearer").read())\'' },
      ]) expect(authorizeLocalToolCall(guarded, 'bash', payload).ok).toBe(false)
      expect(authorizeLocalToolCall(guarded, 'bash', { command: 'rg -uuu -L PRIVATE .', workdir: f.a }).ok).toBe(false)
      for (const command of ['env rg -uuu -L PRIVATE .', 'command rg -uuu -L PRIVATE .', 'sh -c "rg -uuu -L PRIVATE ."', 'sh -c "cat control-alias/bearer"', 'python3 -c \'print(open("control-alias/bearer").read())\'']) {
        expect(authorizeLocalToolCall(guarded, 'bash', { command, workdir: f.a }).ok).toBe(false)
      }
      for (const command of ['(rg -uuu -L PRIVATE)', 'echo "$(rg -uuu -L PRIVATE)"', 'echo `rg -uuu -L PRIVATE <&-`', 'cat control-*/bearer']) {
        expect(authorizeLocalToolCall(guarded, 'bash', { command, workdir: f.a }).ok).toBe(false)
      }
      expect(authorizeLocalToolCall(guarded, 'bash', { command: `sh -c 'cat "${join(f.a, 'control-alias/bearer')}"'`, workdir: f.b }).ok).toBe(false)
      for (const command of [`env C=${join(f.a, 'control-alias')} sh -c 'cat "$C/bearer"'`, `C=${f.a}; sh -c 'cat "$C/control-alias/bearer"'`]) {
        expect(authorizeLocalToolCall(guarded, 'bash', { command, workdir: f.b }).ok).toBe(false)
      }
      for (const command of [`(cat ${join(f.a, 'control-alias/bearer')})`, `echo "$(cat ${join(f.a, 'control-alias/bearer')})"`, `python3 <<'PY'\nprint(open("${join(f.a, 'control-alias/bearer')}").read())\nPY`]) {
        expect(authorizeLocalToolCall(guarded, 'bash', { command, workdir: f.b }).ok).toBe(false)
      }
      for (const command of [`(cat ${join(f.a, 'control-"alias"/bearer')})`, `echo "$(cat ${join(f.a, 'control-"alias"/bearer')})"`, `(cat ${join(f.a, 'control\\-alias/bearer')})`]) {
        expect(authorizeLocalToolCall(guarded, 'bash', { command, workdir: f.b }).ok).toBe(false)
      }
      expect(authorizeLocalToolCall(guarded, 'bash', { command: 'rg PRIVATE .', workdir: f.b }).ok).toBe(true)
    }
  } finally { await f.cleanup() }
})
