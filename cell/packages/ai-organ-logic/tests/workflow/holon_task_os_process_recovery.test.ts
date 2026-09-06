import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execPath } from "node:process"

const roots: string[] = []
const fixture = path.join(import.meta.dir, "fixtures/holonTaskRecoveryProcess.ts")

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function child(root: string, scenario: string, phase: "crash" | "recover"): Promise<number> {
  const childProcess = Bun.spawn([execPath, fixture, root, scenario, phase], {
    stdout: "pipe",
    stderr: "pipe",
  })
  // Kill only this test's child if recovery hangs, and reap it before root cleanup.
  const timer = setTimeout(() => childProcess.kill("SIGKILL"), 18_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      childProcess.exited,
      new Response(childProcess.stdout).text(),
      new Response(childProcess.stderr).text(),
    ])
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: phase === "crash" ? 73 : 0, stdout: "", stderr: "" })
    return childProcess.pid
  } finally {
    clearTimeout(timer)
  }
}

describe("Holon task recovery across independent OS processes", () => {
  const windows = [
    { scenario: "pending", status: "Ready", intents: 0, results: 0, accepted: 0, locks: 0 },
    { scenario: "intent", status: "Running", intents: 1, results: 0, accepted: 0, locks: 1 },
    { scenario: "accepted", status: "Running", intents: 1, results: 0, accepted: 1, locks: 1 },
    { scenario: "accepted-expired", status: "Running", intents: 1, results: 0, accepted: 1, locks: 1 },
    { scenario: "settlement", status: "Succeeded", intents: 1, results: 1, accepted: 1, locks: 0 },
  ] as const
  for (const window of windows) {
    const { scenario } = window
    it(`recovers ${scenario} after process exit using only durable facts`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-os-recovery-"))
      roots.push(root)
      const firstPid = await child(root, scenario, "crash")
      const crash = JSON.parse(await readFile(path.join(root, "crash-evidence.json"), "utf8"))
      expect(crash.pid).toBe(firstPid)
      expect(firstPid).not.toBe(process.pid)
      expect(crash.subscription.recoveryScope.kind).toBe("standalone")
      expect(crash.snapshot.tasks).toHaveLength(1)
      expect(crash.snapshot.tasks[0].status).toBe(window.status)
      expect(crash.intents).toHaveLength(window.intents)
      expect(crash.results).toHaveLength(window.results)
      expect(crash.ledger).toHaveLength(window.accepted)
      expect(crash.locks).toHaveLength(window.locks)
      if (window.locks) expect(crash.locks[0].pid).toBe(firstPid)
      expect(crash.terminal !== null).toBe(scenario === "settlement")

      if (scenario === "accepted-expired") {
        const expiresAt = Date.parse(crash.snapshot.tasks[0].activeClaim.expiresAt)
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 50)))
        expect(Date.now()).toBeGreaterThan(expiresAt)
      }

      const secondPid = await child(root, scenario, "recover")
      expect(secondPid).not.toBe(firstPid)
      expect(secondPid).not.toBe(process.pid)
      const { recovery, repeatedRecovery, completed, repeated, replay, observation } = JSON.parse(
        await readFile(path.join(root, "recovery-evidence.json"), "utf8"),
      )
      expect(completed.pid).toBe(secondPid)
      expect(completed.subscription).toEqual(crash.subscription)
      expect(completed.snapshot.taskSpaceId).toBe(crash.snapshot.taskSpaceId)
      expect(completed.snapshot.tasks[0].taskId).toBe(crash.snapshot.tasks[0].taskId)
      const alreadySettled = scenario === "settlement"
      expect(recovery).toEqual({
        recovered: alreadySettled ? 0 : 1,
        scheduled: alreadySettled ? 0 : 1,
        terminal: alreadySettled ? 1 : 0,
      })
      expect(repeatedRecovery).toEqual({ recovered: 0, scheduled: 0, terminal: 1 })
      expect(completed.ledger).toHaveLength(1)
      expect(completed.ledger[0].acceptedByPid).toBe(window.accepted ? firstPid : secondPid)
      if (window.accepted) expect(completed.ledger).toEqual(crash.ledger)
      expect(completed.results).toHaveLength(1)
      expect(completed.intents).toHaveLength(scenario === "accepted-expired" ? 2 : 1)
      if (scenario === "accepted-expired") {
        expect(completed.intents).toContainEqual(crash.intents[0])
        expect(completed.intents.map((intent: { invocationRef: string }) => intent.invocationRef))
          .toEqual([completed.ledger[0].idempotencyKey, completed.ledger[0].idempotencyKey])
        expect(completed.intents.map((intent: { attempt: number }) => intent.attempt).sort()).toEqual([1, 2])
      } else if (window.intents) {
        expect(completed.intents).toEqual(crash.intents)
      }
      expect(completed.results[0].invocationRef).toBe(completed.ledger[0].idempotencyKey)
      expect(completed.results[0].output).toEqual(completed.ledger[0].output)
      expect(completed.snapshot.tasks[0].status).toBe("Succeeded")
      expect(completed.terminal.receipt.status).toBe("Succeeded")
      expect(observation).toMatchObject({ status: "succeeded", result: completed.ledger[0].output, replayed: true })
      expect(replay.settlement).toEqual(scenario === "pending" ? null : observation)
      expect(replay.task.replayed).toBe(true)
      expect(replay.coordinatorWake.replayed).toBe(true)
      expect(repeated.snapshot).toEqual(completed.snapshot)
      expect(repeated.terminal).toEqual(completed.terminal)
      expect(repeated.ledger).toEqual(completed.ledger)
      expect(repeated.results).toEqual(completed.results)
      expect(repeated.intents).toEqual(completed.intents)
      // An expired attempt has its own abandoned lock; B uses the new attempt's
      // lock and must not delete unrelated locks to make recovery pass.
      expect(repeated.locks).toEqual(scenario === "accepted-expired" ? crash.locks : [])
    }, 40_000)
  }
})
