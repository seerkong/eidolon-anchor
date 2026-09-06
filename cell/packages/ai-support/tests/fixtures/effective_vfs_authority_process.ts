import { VirtualFileSystem } from "xnl-vfs"
import { LocalFileEffectiveEidolonVfsAuthority } from "../../src/runtime/LocalFileEffectiveEidolonVfsAuthority"
import { EffectiveEidolonVfsMaterializer, createMutationEidolonOverlay } from "@cell/symbiont-logic/resource/EffectiveEidolonVfsMaterializer"

const [mode, databasePath, workspaceEidolonRoot, argument] = process.argv.slice(2)
const vfs = new VirtualFileSystem(); vfs.mkdir("vfs:///.eidolon/resources", { recursive: true })
const kill = () => { process.kill(process.pid, "SIGKILL") }
const owner = new LocalFileEffectiveEidolonVfsAuthority({
  databasePath: databasePath!, workspaceEidolonRoot: workspaceEidolonRoot!, builtinSnapshot: vfs.getSnapshot(),
  ...(mode === "crash-after" ? { afterCommit: kill } : {}),
  ...(mode === "crash-before" ? { beforeCommit: kill } : {}),
})
if (mode === "race") {
  const { expectedRevision, value } = JSON.parse(argument!)
  vfs.writeFile("vfs:///.eidolon/resources/Race.xnl", value, { fileType: "xnl", metadataId: "race" })
  console.log(JSON.stringify(owner.compareAndSwap({ expectedRevision, snapshot: vfs.getSnapshot() })))
} else if (mode === "recover") {
  owner.recoverProjections()
  console.log(JSON.stringify(owner.lookupPublication("tx-crash") ?? null))
} else {
  const m = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: vfs.getSnapshot(), authority: owner }); await m.restore()
  const prepared = await m.prepare({ expectedCurrentRevision: m.read().snapshot.revision, overlays: [createMutationEidolonOverlay({
    id: "workspace", kind: "workspace", order: 0, mutations: [{ type: "FILE_CREATE", path: "vfs:///.eidolon/resources/Crash.xnl", expectedId: "crash", payload: { content: "<Crash #committed>", fileType: "xnl" } }],
  })] })
  if (prepared.status !== "prepared") throw new Error("prepare")
  await m.admit(prepared.candidate, { transactionId: "tx-crash", planDigest: "crash-plan", receiptDigest: "crash-receipt" }, {
    logicalPath: "/.eidolon/resources/Crash.xnl", before: { state: "absent" }, authorityText: "<Crash #committed>",
  })
}
owner.close()
