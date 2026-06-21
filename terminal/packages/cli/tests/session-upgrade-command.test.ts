import { describe, expect, test } from "bun:test"
import yargs from "yargs"

import {
  createSessionUpgradeCommand,
  type SessionUpgradeCommandProcessLike,
} from "../src/commands/session-upgrade"

describe("session-upgrade command", () => {
  test("defaults to dry-run and prints JSON", async () => {
    const writes: string[] = []
    const errors: string[] = []
    const calls: any[] = []
    const processLike: SessionUpgradeCommandProcessLike = {
      stdout: {
        write: (chunk: string) => {
          writes.push(chunk)
          return true
        },
      },
      stderr: { write: () => true },
      exitCode: 0,
    }

    const command = createSessionUpgradeCommand({
      dryRunSessionUpgrade: async (input) => {
        calls.push(["dry-run", input])
        return {
          status: "dry_run",
          mode: "file-store",
          upgraded: false,
          hasCheckpoint: false,
          classification: "pending",
          blockers: [{ reason: "missing_commit_marker" }],
          canUpgrade: true,
          plannedHeads: { runtime_snapshot: 1 },
          upgrade: null,
          checkpointMarker: null,
        }
      },
      applySessionUpgrade: async () => {
        throw new Error("should not apply")
      },
      processLike,
      reportError: (message) => {
        errors.push(message)
      },
    })

    await yargs(["session-upgrade", "--session-dir", "/tmp/session"])
      .scriptName("eidolon")
      .command(command)
      .exitProcess(false)
      .parseAsync()

    expect(calls).toEqual([["dry-run", { sessionDir: "/tmp/session" }]])
    expect(JSON.parse(writes.join(""))).toEqual(expect.objectContaining({
      status: "dry_run",
      canUpgrade: true,
    }))
    expect(errors).toEqual([])
    expect(processLike.exitCode).toBe(0)
  })

  test("applies when --apply is provided", async () => {
    const writes: string[] = []
    const calls: any[] = []
    const processLike: SessionUpgradeCommandProcessLike = {
      stdout: {
        write: (chunk: string) => {
          writes.push(chunk)
          return true
        },
      },
      stderr: { write: () => true },
      exitCode: 0,
    }

    const command = createSessionUpgradeCommand({
      dryRunSessionUpgrade: async () => {
        throw new Error("should not dry-run")
      },
      applySessionUpgrade: async (input) => {
        calls.push(["apply", input])
        return {
          status: "already_upgraded",
          mode: "file-store",
          dryRun: {
            status: "dry_run",
            mode: "file-store",
            upgraded: true,
            hasCheckpoint: true,
            classification: "clean",
            blockers: [],
            canUpgrade: false,
            plannedHeads: { runtime_snapshot: 2 },
            upgrade: {
              version: 1,
              strategy: "irreversible_owned_checkpoint",
              checkpointCohortId: "checkpoint",
              checkpointMarker: "checkpoint:runtime_snapshot=2",
              headSequences: { runtime_snapshot: 2 },
              previousCheckpointMarker: null,
              upgradedAt: "2026-06-06T00:00:00.000Z",
            },
            checkpointMarker: "checkpoint:runtime_snapshot=2",
          },
        }
      },
      processLike,
      reportError: () => {},
    })

    await yargs(["session-upgrade", "--session-dir", "/tmp/session", "--apply"])
      .scriptName("eidolon")
      .command(command)
      .exitProcess(false)
      .parseAsync()

    expect(calls).toEqual([["apply", { sessionDir: "/tmp/session" }]])
    expect(JSON.parse(writes.join(""))).toEqual(expect.objectContaining({
      status: "already_upgraded",
      mode: "file-store",
    }))
    expect(processLike.exitCode).toBe(0)
  })

  test("rejects mutually exclusive dry-run and apply flags", async () => {
    const errors: string[] = []
    let calls = 0
    const processLike: SessionUpgradeCommandProcessLike = {
      stdout: { write: () => true },
      stderr: { write: () => true },
      exitCode: 0,
    }
    const command = createSessionUpgradeCommand({
      dryRunSessionUpgrade: async () => {
        calls += 1
        throw new Error("should not run")
      },
      applySessionUpgrade: async () => {
        calls += 1
        throw new Error("should not run")
      },
      processLike,
      reportError: (message) => {
        errors.push(message)
      },
    })

    await yargs(["session-upgrade", "--session-dir", "/tmp/session", "--dry-run", "--apply"])
      .scriptName("eidolon")
      .command(command)
      .exitProcess(false)
      .parseAsync()

    expect(calls).toBe(0)
    expect(errors).toEqual(["Use either --dry-run or --apply, not both"])
    expect(processLike.exitCode).toBe(2)
  })
})
