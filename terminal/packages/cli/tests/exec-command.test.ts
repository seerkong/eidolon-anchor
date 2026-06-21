import { describe, expect, test } from "bun:test"
import yargs from "yargs"

import {
  createExecCommand,
  resolveExecApprovalMode,
  type ExecCommandProcessLike,
} from "../src/commands/exec"

describe("exec command", () => {
  test("maps codex-compatible args into headless exec options", async () => {
    const writes: string[] = []
    const errors: string[] = []
    const calls: any[] = []
    const processLike: ExecCommandProcessLike = {
      env: { PWD: "/launch" },
      cwd: () => "/fallback",
      stdout: {
        write: (chunk: string) => {
          writes.push(chunk)
          return true
        },
      },
      stderr: {
        write: () => true,
      },
      exitCode: 0,
    }

    const command = createExecCommand({
      parseExecConfigOverride: (raw) => {
        expect(raw).toBe("mcp_servers={}")
        return { mcp: false }
      },
      readHeadlessInput: async (prompt) => {
        expect(prompt).toBeUndefined()
        return "stdin prompt"
      },
      resolveProjectWorkDir: (launchCwd, rawWorkDir) => {
        expect(launchCwd).toBe("/launch")
        expect(rawWorkDir).toBe("repo")
        return "/resolved/workspace"
      },
      runHeadlessExec: async (options) => {
        calls.push(options)
        await options.onVisibleChunk?.("visible reply")
        return {
          status: "completed",
          visibleOutput: "visible reply",
          finalMessage: "visible reply",
          warnings: [],
          failureSummary: null,
          outputLastMessagePath: options.outputLastMessagePath,
        }
      },
      processLike,
      reportError: (message) => {
        errors.push(message)
      },
    })

    await yargs([
      "exec",
      "-",
      "-C",
      "repo",
      "--full-auto",
      "--ephemeral",
      "--add-dir",
      "../cache",
      "--add-dir",
      "/tmp/shared",
      "-m",
      "gpt-5",
      "--session",
      "session-123",
      "-p",
      "bench",
      "-c",
      "mcp_servers={}",
      "-o",
      "last.txt",
      "--output-trace",
      "trace.jsonl",
      "--timeout",
      "42",
      "--debug",
    ])
      .scriptName("terminal")
      .command(command)
      .exitProcess(false)
      .parseAsync()

    expect(calls).toEqual([
      {
        workDir: "/resolved/workspace",
        input: "stdin prompt",
        sessionKey: "session-123",
        model: "gpt-5",
        profile: "bench",
        timeoutSeconds: 42,
        debug: true,
        mcp: false,
        ephemeral: true,
        approvalMode: "full-auto",
        additionalWritableRoots: ["../cache", "/tmp/shared"],
        outputLastMessagePath: "last.txt",
        outputTracePath: "trace.jsonl",
        onVisibleChunk: expect.any(Function),
        onDiagnosticLine: expect.any(Function),
      },
    ])
    expect(writes).toEqual(["visible reply", "\n"])
    expect(errors).toEqual([])
    expect(processLike.exitCode).toBe(0)
  })

  test("returns usage error for unsupported config overrides", async () => {
    const errors: string[] = []
    const processLike: ExecCommandProcessLike = {
      env: {},
      cwd: () => "/cwd",
      stdout: { write: () => true },
      stderr: { write: () => true },
      exitCode: 0,
    }
    let runCalls = 0

    const command = createExecCommand({
      parseExecConfigOverride: () => {
        throw new Error("Unsupported exec config override: foo=bar")
      },
      readHeadlessInput: async () => "prompt",
      resolveProjectWorkDir: () => "/resolved",
      runHeadlessExec: async () => {
        runCalls += 1
        throw new Error("should not run")
      },
      processLike,
      reportError: (message) => {
        errors.push(message)
      },
    })

    await yargs(["exec", "do work", "-c", "foo=bar"])
      .scriptName("terminal")
      .command(command)
      .exitProcess(false)
      .parseAsync()

    expect(runCalls).toBe(0)
    expect(errors).toEqual(["Unsupported exec config override: foo=bar"])
    expect(processLike.exitCode).toBe(2)
  })

  test("maps yolo alias into dangerous approval mode", async () => {
    const calls: any[] = []
    const processLike: ExecCommandProcessLike = {
      env: { PWD: "/launch" },
      cwd: () => "/fallback",
      stdout: { write: () => true },
      stderr: { write: () => true },
      exitCode: 0,
    }

    const command = createExecCommand({
      parseExecConfigOverride: () => ({ mcp: true }),
      readHeadlessInput: async (prompt) => prompt,
      resolveProjectWorkDir: () => "/resolved/workspace",
      runHeadlessExec: async (options) => {
        calls.push(options)
        return {
          status: "completed",
          visibleOutput: "done",
          finalMessage: "done",
          warnings: [],
          failureSummary: null,
        }
      },
      processLike,
      reportError: () => {},
    })

    await yargs(["exec", "do work", "--yolo"])
      .scriptName("terminal")
      .command(command)
      .exitProcess(false)
      .parseAsync()

    expect(calls).toHaveLength(1)
    expect(calls[0].approvalMode).toBe("dangerous")
  })

  test("resolves approval mode precedence", () => {
    expect(resolveExecApprovalMode({})).toBe("default")
    expect(resolveExecApprovalMode({ fullAuto: true })).toBe("full-auto")
    expect(
      resolveExecApprovalMode({
        fullAuto: true,
        dangerouslyBypassApprovalsAndSandbox: true,
      }),
    ).toBe("dangerous")
  })
})
