import { describe, expect, test } from "bun:test"
import yargs from "yargs"

import { createSessionForkCommand } from "../src/commands/session-fork"

function processHarness() {
  const writes: string[] = []
  const processLike = {
    env: { PWD: "/launch" },
    cwd: () => "/fallback",
    stdout: { write: (chunk: string) => (writes.push(chunk), true) },
    stderr: { write: () => true },
    exitCode: 0,
  }
  return { writes, processLike }
}

describe("session-fork command", () => {
  test("projects canonical message-level args into the shared headless Conversation command", async () => {
    const { writes, processLike } = processHarness()
    const calls: unknown[] = []
    const command = createSessionForkCommand({
      resolveProjectWorkDir: (_launchCwd, project) => `/resolved/${project}`,
      runHeadlessConversationFork: async (options) => {
        calls.push(options)
        return {
          status: "committed",
          receipt: { targetSessionId: "child", mode: "create" },
        } as any
      },
      processLike,
    })

    await yargs([
      "session-fork", "repo", "--source", "parent", "--target", "child",
      "--message", "canonical-message", "--model", "provider/model", "--no-mcp",
    ])
      .command(command)
      .exitProcess(false)
      .parseAsync()

    expect(calls).toEqual([{
      workDir: "/resolved/repo",
      sourceSessionId: "parent",
      targetSessionId: "child",
      messageId: "canonical-message",
      adapter: undefined,
      model: "provider/model",
      debug: false,
      mcp: false,
    }])
    expect(JSON.parse(writes.join(""))).toMatchObject({
      status: "committed",
      receipt: { targetSessionId: "child", mode: "create" },
    })
    expect(processLike.exitCode).toBe(0)
  })

  test("preserves typed domain rejection and sets a non-success exit code", async () => {
    const { writes, processLike } = processHarness()
    const command = createSessionForkCommand({
      resolveProjectWorkDir: () => "/resolved/repo",
      runHeadlessConversationFork: async () => ({
        status: "rejected",
        rejection: { code: "PROMPT_STATE_UNPROVABLE", message: "compaction boundary" },
      }),
      processLike,
    })

    await yargs(["session-fork", "--source", "parent"])
      .command(command)
      .exitProcess(false)
      .parseAsync()

    expect(JSON.parse(writes.join(""))).toMatchObject({
      status: "rejected",
      rejection: { code: "PROMPT_STATE_UNPROVABLE" },
    })
    expect(processLike.exitCode).toBe(2)
  })
})
