import { describe, expect, test } from "bun:test"
import { createKernelSlashCommandDescriptors } from "../src/slash/commands"
import { getAiSlashNamespaceHelp, resolveAiSlashCommand } from "../src/slash"

const commands = createKernelSlashCommandDescriptors()
const selector = { admissionId: "admission:a", taskSpaceId: "space:a", taskId: "task:a" }

describe("direct Holon task commands", () => {
  test("observation passes the same structured selector to the official tool", () => {
    const args = { selector }
    const resolved = resolveAiSlashCommand(`/holon task-observe ${JSON.stringify(args)}`, commands)
    expect(resolved).toEqual({ kind: "direct_execute", namespace: "holon", command: "/holon", action: "task-observe", args })
    expect(commands.find(({ namespace }) => namespace === "holon")?.actions["task-observe"]?.toolName).toBe("HolonTaskObserve")
  })

  test("repair preserves explicit CAS, request identity and user input bytes", () => {
    const args = { selector, invocation: {
      kind: "successor", requestId: "repair:a", expectedRevision: 7,
      reason: "采用新 Worker，保留失败前驱", occurredAt: "2026-09-05T10:00:00.000Z",
      target: { kind: "admission", admissionId: "admission:b" }, input: { text: "keep  two spaces\nand newline" }, name: "retry",
    } }
    const resolved = resolveAiSlashCommand(`/holon task-repair ${JSON.stringify(args)}`, commands)
    expect(resolved).toMatchObject({ kind: "direct_execute", action: "task-repair", args })
    expect(commands.find(({ namespace }) => namespace === "holon")?.actions["task-repair"]?.toolName).toBe("HolonTaskRepair")
  })

  test.each(["", "{broken", "null", "[]", '"text"', "1"])("rejects invalid JSON object %j without prompt fallback", (input) => {
    expect(() => resolveAiSlashCommand(`/holon task-repair ${input}`, commands)).toThrow("SLASH_COMMAND_JSON_OBJECT_REQUIRED")
  })

  test("both official commands are discoverable without invoking a model", () => {
    const help = getAiSlashNamespaceHelp("holon", commands)
    expect(help).toContain("/holon task-observe")
    expect(help).toContain("/holon task-repair")
    expect(resolveAiSlashCommand("/holon help", commands)).toMatchObject({ kind: "direct_execute", action: "help" })
  })

  test("pasted multiline JSON remains a direct command, including malformed input", () => {
    expect(resolveAiSlashCommand(`/holon task-observe ${JSON.stringify({ selector }, null, 2)}`, commands))
      .toMatchObject({ kind: "direct_execute", args: { selector } })
    expect(() => resolveAiSlashCommand('/holon task-repair {\n"selector":', commands))
      .toThrow("SLASH_COMMAND_JSON_OBJECT_REQUIRED")
  })

  test.each(["\n", "\t", "\r\n"])("JSON action recognizes whitespace delimiter %j without provider fallback", (delimiter) => {
    expect(resolveAiSlashCommand(`/holon task-observe${delimiter}${JSON.stringify({ selector })}`, commands))
      .toMatchObject({ kind: "direct_execute", args: { selector } })
    expect(() => resolveAiSlashCommand(`/holon task-repair${delimiter}{broken`, commands))
      .toThrow("SLASH_COMMAND_JSON_OBJECT_REQUIRED")
  })
})
