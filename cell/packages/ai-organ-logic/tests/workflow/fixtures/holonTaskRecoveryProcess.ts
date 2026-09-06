import { createHash } from "node:crypto"
import { mkdir, open, readFile, readdir } from "node:fs/promises"
import path from "node:path"

import { invocation, openHost, waitForTerminal } from "./holonTaskFileRuntime"

const [root, scenario, phase] = process.argv.slice(2)
if (!root || !["pending", "intent", "accepted", "accepted-expired", "settlement"].includes(scenario!)
  || !["crash", "recover"].includes(phase!)) throw new Error("Invalid recovery fixture arguments")

// The expired case restarts after its short task lease; other windows keep the
// original attempt leased while the crashed journal lock ages out (5s).
const processorConfig = Object.freeze({ leaseDurationMs: scenario === "accepted-expired" ? 1_000 : 30_000, maxSteps: 16 })

// This ledger is the external adapter's authority. Each process reads it anew.
// A completed record is synced before acceptance is acknowledged to the runtime.
const ledgerDirectory = path.join(root, "external-effects")
await mkdir(ledgerDirectory, { recursive: true })

async function writeDurable(file: string, value: unknown): Promise<void> {
  const handle = await open(file, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(value))
    await handle.sync()
  } finally {
    await handle.close()
  }
  const directory = await open(path.dirname(file), "r")
  try { await directory.sync() } finally { await directory.close() }
}

async function records(directory: string, extension = ".json"): Promise<any[]> {
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  return Promise.all(names.filter((name) => name.endsWith(extension))
    .sort().map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8"))))
}

async function evidence() {
  const [subscription] = await host.support.listSubscriptions()
  if (!subscription) throw new Error("Crash window has no durable subscription")
  const snapshot = await host.support.taskManager.owner.readSnapshot(subscription.taskSpaceId)
  const terminal = await host.support.terminalSettlement(subscription.taskSpaceId, subscription.taskId)
  return {
    pid: process.pid,
    scenario,
    subscription,
    snapshot,
    terminal: terminal ?? null,
    intents: await records(path.join(root, "holon-task-pump", "intents")),
    results: await records(path.join(root, "holon-task-pump", "results")),
    locks: await records(path.join(root, "holon-task-pump", "locks"), ".lock"),
    ledger: await records(ledgerDirectory),
  }
}

async function crash(): Promise<never> {
  await writeDurable(path.join(root, "crash-evidence.json"), await evidence())
  // Deliberately bypass coordinator close and journal finally/release.
  process.exit(73)
}

const host = await openHost({
  root,
  processorConfig,
  waitingProbeMs: phase === "crash" && scenario === "pending" ? 60_000 : 5,
  actorDispatch: {
    async dispatch({ idempotencyKey, invocation: request }) {
      if (phase === "crash" && scenario === "intent") await crash()
      const target = path.join(ledgerDirectory, `${createHash("sha256").update(idempotencyKey).digest("hex")}.json`)
      let accepted
      try {
        accepted = JSON.parse(await readFile(target, "utf8"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (accepted) {
        if (accepted.idempotencyKey !== idempotencyKey || accepted.taskRef !== request.taskRef) {
          throw new Error("External idempotency fingerprint conflict")
        }
        return Object.freeze({ output: accepted.output, replayed: true })
      }
      const output = Object.freeze({ summary: `completed:${request.taskRef}` })
      await writeDurable(target, { idempotencyKey, taskRef: request.taskRef, output, acceptedByPid: process.pid })
      if (phase === "crash" && (scenario === "accepted" || scenario === "accepted-expired")) await crash()
      return Object.freeze({ output, replayed: false })
    },
  },
  transformRoute: (route) => ({
    ...route,
    coordinatorMailbox: {
      async sendWake(message) {
        const receipt = await route.coordinatorMailbox.sendWake(message)
        // A final wake has settled TaskSpace, but service.assign has not observed it.
        if (phase === "crash" && scenario === "settlement") await crash()
        return receipt
      },
    },
  }),
})

if (phase === "crash") {
  await host.capability.service.assign(
    { kind: "holon", holonRef: "holon-review" },
    invocation(`os-process-${scenario}`, scenario === "pending" ? "none" : "final"),
    processorConfig,
  )
  if (scenario === "pending") await crash()
  throw new Error(`Did not reach ${scenario} crash window`)
}

try {
  const recovery = await host.support.recoverPending()
  const [subscription] = await host.support.listSubscriptions()
  if (!subscription) throw new Error("Recovery did not find a durable subscription")
  await waitForTerminal(host, subscription.taskSpaceId, subscription.taskId, 12_000)
  const completed = await evidence()
  const repeatedRecovery = await host.support.recoverPending()
  await host.support.wakeSubscription(subscription)
  const replay = await host.capability.service.assign(
    { kind: "holon", holonRef: "holon-review" },
    invocation(`os-process-${scenario}`, scenario === "pending" ? "none" : "final"),
    processorConfig,
  )
  const observation = await host.route.settlement.observe({
    taskSpaceId: subscription.taskSpaceId,
    taskId: subscription.taskId,
    requestId: `os-process-${scenario}`,
  })
  const repeated = await evidence()
  await writeDurable(path.join(root, "recovery-evidence.json"), { recovery, repeatedRecovery, completed, repeated, replay, observation })
} finally {
  host.support.close()
}
