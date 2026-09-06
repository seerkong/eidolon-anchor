import { afterEach, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { VirtualFileSystem } from "xnl-vfs"
import { LocalFileEffectiveEidolonVfsAuthority } from "../src/runtime/LocalFileEffectiveEidolonVfsAuthority"
import { EffectiveEidolonVfsMaterializer, createMutationEidolonOverlay } from "@cell/symbiont-logic/resource/EffectiveEidolonVfsMaterializer"
import type { EffectiveEidolonVfsPublicationAuthority } from "@cell/symbiont-logic/resource/EffectiveEidolonVfsPublication"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "eidolon-vfs-authority-")); roots.push(root)
  const workspace = path.join(root, "workspace")
  await mkdir(path.join(workspace, "resources"), { recursive: true })
  const vfs = new VirtualFileSystem(); vfs.mkdir("vfs:///.eidolon/resources", { recursive: true })
  const options = { databasePath: path.join(root, "authority.sqlite"), workspaceEidolonRoot: workspace, builtinSnapshot: vfs.getSnapshot() }
  return { options, workspace, vfs }
}
function overlay(text: string) {
  return createMutationEidolonOverlay({ id: "workspace", kind: "workspace", order: 0, mutations: [{ type: "FILE_CREATE", path: "vfs:///.eidolon/resources/Test.xnl", expectedId: "test", payload: { content: text, fileType: "xnl" } }] })
}
it("uses real durable CAS across connections and restores exact publication history after later versions", async () => {
  const f = await fixture()
  const first = new LocalFileEffectiveEidolonVfsAuthority(f.options)
  const second = new LocalFileEffectiveEidolonVfsAuthority(f.options)
  const a = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: f.vfs.getSnapshot(), authority: first })
  const b = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: f.vfs.getSnapshot(), authority: second })
  await a.restore(); await b.restore()
  const old = b.read().snapshot.revision
  const one = await a.prepare({ expectedCurrentRevision: a.read().snapshot.revision, overlays: [overlay("<Test #one>")] })
  expect(one.status).toBe("prepared"); if (one.status !== "prepared") throw new Error("prepare")
  const result = await a.admit(one.candidate, { transactionId: "tx-one", planDigest: "plan-one", receiptDigest: "receipt-one" }, {
    logicalPath: "/.eidolon/resources/Test.xnl", before: { state: "absent" }, authorityText: "<Test #one>",
  })
  expect(result.status).toBe("admitted")
  const receipt = await first.lookupPublication("tx-one")
  expect(receipt?.association?.receiptDigest).toBe("receipt-one")
  expect(await readFile(path.join(f.workspace, "resources/Test.xnl"), "utf8")).toBe("<Test #one>")
  expect((await b.prepare({ expectedCurrentRevision: old, overlays: [overlay("<Test #stale>")] })).status).not.toBe("prepared")
  await b.restore()
  const newer = await b.materialize({ expectedCurrentRevision: b.read().snapshot.revision, overlays: [overlay("<Test #two>")] })
  expect(newer.status).toBe("admitted")
  first.close(); second.close()
  const reopened = new LocalFileEffectiveEidolonVfsAuthority(f.options)
  expect(await reopened.lookupPublication("tx-one")).toEqual(receipt)
  const restored = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: f.vfs.getSnapshot(), authority: reopened })
  await restored.restore()
  expect(new TextDecoder().decode(await restored.read().readPort.readBytes("/.eidolon/resources/Test.xnl"))).toBe("<Test #two>")
  reopened.close()
})

it("retains the exact unchanged publication receipt and rejects stale native no-ops", async () => {
  const f = await fixture(); const owner = new LocalFileEffectiveEidolonVfsAuthority(f.options)
  const m = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: f.vfs.getSnapshot(), authority: owner })
  await m.restore(); const initial = owner.read()
  await m.materialize({ expectedCurrentRevision: m.read().snapshot.revision, overlays: [overlay("<Test #one>")] })
  const input = { expectedCurrentRevision: m.read().snapshot.revision, overlays: [overlay("<Test #one>")] }
  const a = await m.materialize(input); const b = await m.materialize(input)
  expect(a.status).toBe("admitted"); expect(b.status).toBe("admitted")
  if (a.status === "admitted" && b.status === "admitted") expect(b.receipt).toEqual(a.receipt)
  expect((await owner.compareAndSwap({ expectedRevision: initial.revision, snapshot: owner.read().snapshot })).status).toBe("conflict")
  owner.close()
})

function child(f: Awaited<ReturnType<typeof fixture>>, mode: string, argument = "") {
  const localBinding = path.resolve(".tmp/holon-resource-autonomy-source.json")
  const tsconfig = process.env.EIDOLON_TEST_TSCONFIG ?? (existsSync(localBinding) ? localBinding : path.resolve("cell/tsconfig.json"))
  return Bun.spawn([process.execPath, "--tsconfig-override", tsconfig, path.join(import.meta.dir, "fixtures/effective_vfs_authority_process.ts"), mode, f.options.databasePath, f.workspace, argument], { stdout: "pipe", stderr: "pipe" })
}

it("serializes two OS writers on the original native CAS token", async () => {
  const f = await fixture(); const owner = new LocalFileEffectiveEidolonVfsAuthority(f.options)
  const expectedRevision = owner.read().revision; owner.close()
  const workers = ["one", "two"].map(value => child(f, "race", JSON.stringify({ expectedRevision, value })))
  const outputs = await Promise.all(workers.map(async worker => {
    const [stdout, stderr, exit] = await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited])
    expect(exit, stderr).toBe(0); return JSON.parse(stdout)
  }))
  expect(outputs.map(output => output.status).sort()).toEqual(["applied", "conflict"])
})

it.each(["crash-before", "crash-after"])("recovers a real SIGKILL at %s without inventing or losing publication", async mode => {
  const f = await fixture(); const killed = child(f, mode)
  expect(await killed.exited).not.toBe(0)
  await expect(readFile(path.join(f.workspace, "resources/Crash.xnl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  const recovery = child(f, "recover")
  const [stdout, stderr, exit] = await Promise.all([new Response(recovery.stdout).text(), new Response(recovery.stderr).text(), recovery.exited])
  expect(exit, stderr).toBe(0)
  const proof = JSON.parse(stdout)
  if (mode === "crash-before") {
    expect(proof).toBeNull()
    await expect(readFile(path.join(f.workspace, "resources/Crash.xnl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  } else {
    expect(proof.association.transactionId).toBe("tx-crash")
    expect(await readFile(path.join(f.workspace, "resources/Crash.xnl"), "utf8")).toBe("<Crash #committed>")
    const secondRecovery = child(f, "recover")
    expect(await new Response(secondRecovery.stdout).json()).toEqual(proof)
    expect(await secondRecovery.exited).toBe(0)
  }
})

it("keeps admitted proof and external bytes when a pending physical projection cannot be reconciled", async () => {
  const f = await fixture(); const killed = child(f, "crash-after"); await killed.exited
  const target = path.join(f.workspace, "resources/Crash.xnl"); await writeFile(target, "external edit")
  const owner = new LocalFileEffectiveEidolonVfsAuthority(f.options)
  expect(() => owner.recoverProjections()).toThrow("EXTERNAL_CHANGE")
  expect(owner.lookupPublication("tx-crash")?.receipt.status).toBe("admitted")
  expect(await readFile(target, "utf8")).toBe("external edit")
  owner.close()
})

it("uses the exact committed snapshot when a successor publishes before the first caller resumes", async () => {
  const f = await fixture(); const owner = new LocalFileEffectiveEidolonVfsAuthority(f.options)
  let advanced = false
  const racing: EffectiveEidolonVfsPublicationAuthority = {
    read: () => owner.read(), readHead: () => owner.readHead(),
    compareAndSwap: input => owner.compareAndSwap(input),
    lookupPublication: key => owner.lookupPublication(key), recoverProjections: () => owner.recoverProjections(),
    scopePublication(context) {
      const scope = owner.scopePublication(context)
      return { read: scope.read, async compareAndSwap(input) {
        const result = await scope.compareAndSwap(input)
        if (!advanced && result.status === "applied") {
          advanced = true
          const successor = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: f.vfs.getSnapshot(), authority: owner })
          await successor.restore()
          expect((await successor.materialize({ expectedCurrentRevision: successor.read().snapshot.revision, overlays: [overlay("<Test #successor>")] })).status).toBe("admitted")
        }
        return result
      } }
    },
  }
  const first = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: f.vfs.getSnapshot(), authority: racing })
  await first.restore()
  const result = await first.materialize({ expectedCurrentRevision: first.read().snapshot.revision, overlays: [overlay("<Test #original>")] })
  expect(result.status).toBe("admitted")
  if (result.status === "admitted") expect(new TextDecoder().decode(await result.effective.readPort.readBytes("/.eidolon/resources/Test.xnl"))).toBe("<Test #original>")
  await first.restore()
  expect(new TextDecoder().decode(await first.read().readPort.readBytes("/.eidolon/resources/Test.xnl"))).toBe("<Test #successor>")
  owner.close()
})

it("rejects a projection with a forged before-image before committing its head or receipt", async () => {
  const f = await fixture(); const owner = new LocalFileEffectiveEidolonVfsAuthority(f.options)
  const m = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: f.vfs.getSnapshot(), authority: owner }); await m.restore()
  const before = owner.read()
  const prepared = await m.prepare({ expectedCurrentRevision: m.read().snapshot.revision, overlays: [overlay("<Test #one>")] })
  if (prepared.status !== "prepared") throw new Error("prepare")
  const malformed = { logicalPath: "/.eidolon/resources/Test.xnl", before: { state: "invented" }, authorityText: "<Test #one>" } as any
  await expect(m.admit(prepared.candidate, { transactionId: "invalid", planDigest: "plan", receiptDigest: "receipt" }, malformed)).rejects.toThrow("BEFORE_IMAGE_INVALID")
  expect(owner.read()).toEqual(before)
  expect(owner.lookupPublication("invalid")).toBeUndefined()
  owner.close()
})

it.each(["history", "head", "context", "missing-digest"])("fails closed on accidental %s publication corruption", async field => {
  const f = await fixture(); const killed = child(f, "crash-after"); await killed.exited
  const owner = new LocalFileEffectiveEidolonVfsAuthority(f.options)
  const db = new Database(f.options.databasePath)
  try {
    if (field === "head") {
      const row = db.query("SELECT data FROM vfs_head WHERE id=1").get() as { data: string }
      const head = JSON.parse(row.data); head.publication.association.receiptDigest = "corrupt"
      db.query("UPDATE vfs_head SET data=? WHERE id=1").run(JSON.stringify(head))
    } else if (field === "history") {
      const row = db.query("SELECT record FROM vfs_publications WHERE publication_key='tx-crash'").get() as { record: string }
      const record = JSON.parse(row.record); record.association.receiptDigest = "corrupt"
      db.query("UPDATE vfs_publications SET record=? WHERE publication_key='tx-crash'").run(JSON.stringify(record))
    } else if (field === "context") {
      const row = db.query("SELECT context FROM vfs_publications WHERE publication_key='tx-crash'").get() as { context: string }
      const context = JSON.parse(row.context); context.workspaceWrite.before = { state: "present", text: "external", digest: "corrupt" }
      db.query("UPDATE vfs_publications SET context=? WHERE publication_key='tx-crash'").run(JSON.stringify(context))
    } else db.query("UPDATE vfs_publications SET record_digest='' WHERE publication_key='tx-crash'").run()
    expect(() => field === "head" ? owner.readHead() : owner.lookupPublication("tx-crash")).toThrow("INTEGRITY")
    expect(() => owner.recoverProjections()).toThrow("INTEGRITY")
    await expect(readFile(path.join(f.workspace, "resources/Crash.xnl"))).rejects.toMatchObject({ code: "ENOENT" })
  } finally { db.close(); owner.close() }
})

it("integrity-binds the pending projection before-image to the admitted input", async () => {
  const f = await fixture(); const killed = child(f, "crash-after"); await killed.exited
  const owner = new LocalFileEffectiveEidolonVfsAuthority(f.options)
  const target = path.join(f.workspace, "resources/Crash.xnl"); await writeFile(target, "external")
  const db = new Database(f.options.databasePath)
  try {
    const row = db.query("SELECT input FROM vfs_pending_projections WHERE publication_key='tx-crash'").get() as { input: string }
    const input = JSON.parse(row.input)
    input.before = { state: "present", text: "external", digest: `sha256:${new Bun.CryptoHasher("sha256").update("external").digest("hex")}` }
    db.query("UPDATE vfs_pending_projections SET input=? WHERE publication_key='tx-crash'").run(JSON.stringify(input))
    expect(owner.lookupPublication("tx-crash")?.receipt.status).toBe("admitted")
    expect(() => owner.recoverProjections()).toThrow("INTEGRITY")
    expect(await readFile(target, "utf8")).toBe("external")
  } finally { db.close(); owner.close() }
})

it("rejects legacy authority rows without minting integrity attestations", async () => {
  const f = await fixture(); const db = new Database(f.options.databasePath)
  db.exec("CREATE TABLE vfs_publications (publication_key TEXT PRIMARY KEY, identity TEXT NOT NULL, record TEXT NOT NULL)")
  db.query("INSERT INTO vfs_publications VALUES (?,?,?)").run("legacy", "old-identity", "{}")
  try {
    expect(() => new LocalFileEffectiveEidolonVfsAuthority(f.options)).toThrow("INTEGRITY_UPGRADE_REQUIRED")
    expect(db.query("SELECT record FROM vfs_publications").get()).toEqual({ record: "{}" })
    expect(db.query("PRAGMA table_info(vfs_publications)").all().map((column: any) => column.name)).toEqual(["publication_key", "identity", "record"])
  } finally { db.close() }
})
