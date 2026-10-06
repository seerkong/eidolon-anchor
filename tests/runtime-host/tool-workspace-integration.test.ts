import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createActor, createVM } from "@cell/ai-core-logic"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { createHostResourceEffects } from "../../cell/packages/ai-runtime-host-support/src"
import { buildWriteToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/Write"
import { buildEditToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/Edit"
import { buildReadToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/Read"
import { buildApplyPatchToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/ApplyPatch"
import { buildBashToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/Bash"
import { buildRunDetachedBashToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/RunDetachedBash"
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver"
import { createAiAgentRuntimeCoordinator } from "@cell/ai-organ-logic/runtime/AiAgentRuntimeCoordinator"
import { MCPManager } from "@cell/ai-organ-logic/mcp/McpSupport"
import { configureLocalPermissionConfigStore } from "@cell/ai-organ-logic/permissions/LocalPermissionConfig"
import { LocalFilePermissionConfigStore } from "@cell/ai-support/permissions/LocalFilePermissionConfigStore"

configureLocalPermissionConfigStore(LocalFilePermissionConfigStore)

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function until(predicate: () => boolean) { const deadline = Date.now() + 5000; while (!predicate() && Date.now() < deadline) await Bun.sleep(5); expect(predicate()).toBe(true) }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "actual-workspace-tools-"))
  const workDir = path.join(root, "work"), alias = path.join(root, "alias")
  fs.mkdirSync(workDir); fs.symlinkSync(workDir, alias)
  const resources = createHostResourceEffects(), registry = new ToolFuncRegistry()
  registry.registerMany([buildWriteToolDef(), buildEditToolDef(), buildReadToolDef(), buildApplyPatchToolDef(), buildBashToolDef()])
  const first = createActor({ key: "first", id: "first", type: "interactive" }), second = createActor({ key: "second", id: "second", type: "interactive" })
  const makeVm = (actor: typeof first, directory: string) => createVM({ controlActorKey: actor.key, actors: { [actor.key]: actor },
    effects: { toolResources: resources }, outerCtx: { workDir: directory, metadata: { exec_protocol: { mode: "dangerous" },
      sandbox_permissions: { sandbox_mode: "danger-full-access" }, local_permissions: { authority_root: path.join(root, "authority") } } } })
  return { root, workDir, resources, registry, first, second, a: makeVm(first, workDir), b: makeVm(second, alias),
    close() { resources.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}

test("actual ApplyPatch holds its canonical workspace lease from hunk freshness through every write", async () => {
  const f = fixture(), granted = deferred()
  const realAcquire = f.resources.acquire.bind(f.resources)
  const order: string[] = []
  let acquisition = 0
  f.resources.acquire = async input => {
    const lease = await realAcquire(input), id = ++acquisition
    order.push(`acquire-${id}`); if (id === 1) granted.resolve()
    return { release() { order.push(`release-${id}`); lease.release() }, invalidate: lease.invalidate }
  }
  const files = Array.from({ length: 20 }, (_, i) => `file-${i}.txt`)
  for (const file of files) fs.writeFileSync(path.join(f.workDir, file), "old-snapshot\n")
  const patchText = ["*** Begin Patch", ...files.flatMap(file => [`*** Update File: ${file}`, "@@", "-old-snapshot", "+authoritative-first"]), "*** End Patch"].join("\n")
  try {
    const patch = f.registry.call("apply_patch", f.a, f.first, { patchText })
    await granted.promise
    const stale = f.registry.call("edit", f.b, f.second, { filePath: files[0], oldString: "old-snapshot", newString: "lost-update" })
    const [applied, rejected] = await Promise.all([patch, stale])
    expect(String(applied)).toContain("Patch applied successfully")
    expect(JSON.parse(String(rejected))).toMatchObject({ error: "not_found" })
    expect(order).toEqual(["acquire-1", "release-1", "acquire-2", "release-2"])
    for (const file of files) expect(fs.readFileSync(path.join(f.workDir, file), "utf8")).toBe("authoritative-first\n")
    expect(await f.registry.call("write", f.b, f.second, { filePath: "written.txt", content: "real write" })).toContain("successfully")
    expect(fs.readFileSync(path.join(f.workDir, "written.txt"), "utf8")).toBe("real write")
  } finally { f.close() }
})

test("actual Bash cancellation retains mutation lease until its SIGTERM-resistant child exits while Read overlaps", async () => {
  const f = fixture(), controller = new AbortController()
  const pidFile = path.join(f.workDir, "child.pid"), script = path.join(f.workDir, "child.cjs")
  fs.writeFileSync(script, `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)
  fs.writeFileSync(path.join(f.workDir, "read.txt"), "read stays available")
  let pid = 0, mutationGrantedWhileChildAlive = false, grants = 0
  const realAcquire = f.resources.acquire.bind(f.resources)
  f.resources.acquire = async input => {
    const lease = await realAcquire(input)
    if (++grants === 2) mutationGrantedWhileChildAlive = alive(pid)
    return lease
  }
  try {
    const bash = f.registry.call("bash", f.a, f.first, { command: `exec ${quote(process.execPath)} ${quote(script)}`, timeoutSeconds: 10 }, { signal: controller.signal })
    await until(() => fs.existsSync(pidFile)); pid = Number(fs.readFileSync(pidFile, "utf8"))
    controller.abort()
    let wrote = false
    const write = f.registry.call("write", f.b, f.second, { filePath: "after.txt", content: "after cleanup" }).then(value => { wrote = true; return value })
    expect(String(await f.registry.call("read", f.b, f.second, { filePath: "read.txt" }))).toContain("read stays available")
    await Bun.sleep(100)
    expect(alive(pid)).toBe(true)
    expect(wrote).toBe(false)
    const result: any = await bash
    await write
    expect(result.outcome).toMatchObject({ status: "failed", failureKind: "aborted" })
    expect(mutationGrantedWhileChildAlive).toBe(false)
    expect(alive(pid)).toBe(false)
    expect(fs.readFileSync(path.join(f.workDir, "after.txt"), "utf8")).toBe("after cleanup")
  } finally { controller.abort(); if (pid && alive(pid)) process.kill(pid, "SIGKILL"); f.close() }
}, 10_000)

test("real MCP stdio abort reports unknown completion and poisons mutations while the remote effect still runs", async () => {
  const f = fixture(), controller = new AbortController()
  const script = path.join(f.workDir, "mcp.cjs"), entered = path.join(f.workDir, "remote-entered"), effect = path.join(f.workDir, "remote-effect")
  fs.writeFileSync(script, `const fs = require('node:fs'); const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); if (!request.id) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'local-fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'late_write', description: 'late local write', inputSchema: { type: 'object' } }] };
  else if (request.method === 'tools/call') { fs.writeFileSync(${JSON.stringify(entered)}, 'started'); setTimeout(() => fs.writeFileSync(${JSON.stringify(effect)}, 'happened after abort'), 200); return; }
  else return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});`)
  const manager = new MCPManager({ fixture: { command: process.execPath, args: [script], requestTimeoutMs: 2000 } })
  try {
    expect(await manager.connectServer("fixture")).toBe(true)
    f.a.mcpManager = manager
    const call = f.registry.call("mcp__fixture__late_write", f.a, f.first, {}, { signal: controller.signal })
    await until(() => fs.existsSync(entered)); controller.abort()
    expect(String(await call)).toContain("aborted")
    await expect(f.registry.call("write", f.b, f.second, { filePath: "must-not-write", content: "bad" })).rejects.toThrow("resource_effect_unsettled")
    await until(() => fs.existsSync(effect))
    expect(String(await f.registry.call("read", f.b, f.second, { filePath: "remote-effect" }))).toContain("happened after abort")
    expect(fs.existsSync(path.join(f.workDir, "must-not-write"))).toBe(false)
  } finally { controller.abort(); manager.closeAll(); f.close() }
}, 10_000)

test("Bash retains its lease when the shell exits before a SIGTERM-resistant grandchild with closed stdio", async () => {
  if (process.platform === "win32") return
  const f = fixture(), controller = new AbortController(), pidFile = path.join(f.workDir, "grandchild.pid")
  const child = path.join(f.workDir, "grandchild.cjs"), parent = path.join(f.workDir, "parent.cjs")
  fs.writeFileSync(child, `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)
  fs.writeFileSync(parent, `require('node:child_process').spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`)
  let pid = 0
  try {
    const bash = f.registry.call("bash", f.a, f.first, { command: `exec ${quote(process.execPath)} ${quote(parent)}`, timeoutSeconds: 10 }, { signal: controller.signal })
    await until(() => fs.existsSync(pidFile)); pid = Number(fs.readFileSync(pidFile, "utf8"))
    controller.abort()
    await f.registry.call("write", f.b, f.second, { filePath: "after-grandchild.txt", content: "next mutation" })
    await bash
    expect(alive(pid)).toBe(false)
  } finally { controller.abort(); if (pid && alive(pid)) process.kill(pid, "SIGKILL"); f.close() }
}, 10_000)

test("direct RunDetachedBash before the first fiber tick remains owned through shutdown", async () => {
  const f = fixture(), completed = path.join(f.workDir, "detached-completed"), script = path.join(f.workDir, "detached.cjs")
  fs.writeFileSync(script, `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(completed)}, 'finished'), 250);`)
  f.registry.register(buildRunDetachedBashToolDef())
  const driver = createAiAgentOrchestratorDriver({ fibers: [{ fiberId: "direct", actor: f.first, vm: f.a, messages: [], basePriority: 1 }],
    runStep: async () => ({ kind: "complete" }) })
  driver.suspendFiber("direct", Date.now(), "idle_external" as any)
  const coordinator = createAiAgentRuntimeCoordinator({ vm: f.a, driver })
  try {
    const result = JSON.parse(String(await f.registry.call("RunDetachedBash", f.a, f.first, {
      command: `exec ${quote(process.execPath)} ${quote(script)}`, agent_type: "test", timeoutSeconds: 5,
    })))
    expect(result.status).toBe("running")
    expect(fs.existsSync(completed)).toBe(false)
    await coordinator.shutdown()
    expect(fs.readFileSync(completed, "utf8")).toBe("finished")
  } finally { await coordinator.shutdown(); coordinator.dispose(); f.close() }
}, 10_000)
