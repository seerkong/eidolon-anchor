import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createActor, type AiAgentVm } from "@cell/ai-core-logic"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { composeToolRegistry } from "../../src/composer/AIAgent/ToolFuncComposer"
import { createKernelSlashCommandDescriptors } from "../../../mod-ai-kernel/src/slash/commands"
import { resolveAiSlashCommand } from "../../../mod-ai-kernel/src/slash"
import { invocation, openHost, waitForTerminal } from "./fixtures/holonTaskFileRuntime"

test("human slash and AI tools share persisted task observation and idempotent resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "holon-human-tool-"))
  let effects = 0
  const host = await openHost({
    root,
    actorDispatch: { async dispatch() { effects++; return { output: { completed: true }, replayed: false } } },
    transformRoute: (route) => ({ ...route, coordinatorMailbox: {
      async sendWake(message) { return { coordinatorActorRef: "paused", messageId: message.messageId, replayed: false } },
    } }),
  })
  try {
    const registry = composeToolRegistry({ includeInternalOnly: true })
    const actor = createActor({ key: "main" })
    const vm = host.vm as AiAgentVm
    const commands = createKernelSlashCommandDescriptors()
    const callSlash = async (input: string) => {
      const resolved = resolveAiSlashCommand(input, commands)
      if (!resolved || resolved.kind !== "direct_execute") throw new Error("Expected direct tool execution")
      const descriptor = commands.find(({ namespace }) => namespace === resolved.namespace)?.actions[resolved.action]
      if (!descriptor) throw new Error("Missing official command descriptor")
      return JSON.parse(String(await ToolFuncRegistry.call(registry, descriptor.toolName, vm, actor, resolved.args)))
    }
    const accepted = await host.capability.service.assign(
      { kind: "admission", admissionId: host.admission.admissionId }, invocation("human", "none"),
      { leaseDurationMs: 5000, maxSteps: 16 },
    )
    const selector = { admissionId: accepted.admissionId, taskSpaceId: accepted.task.taskSpaceId, taskId: accepted.task.taskId }
    const observed = await callSlash(`/holon task-observe ${JSON.stringify({ selector })}`)
    expect(observed.status).toBe("Ready")
    expect(effects).toBe(0)
    const aiObserved = JSON.parse(String(await ToolFuncRegistry.call(registry, "HolonTaskObserve", vm, actor, { selector })))
    expect(aiObserved.revision).toBe(observed.revision)
    expect(aiObserved.status).toBe(observed.status)
    const request = { selector, invocation: {
      kind: "resume", requestId: "human-resume", expectedRevision: observed.revision,
      reason: "continue the paused task", occurredAt: new Date().toISOString(),
    } }
    const repaired = await callSlash(`/holon task-repair ${JSON.stringify(request, null, 2)}`)
    await waitForTerminal(host, selector.taskSpaceId, selector.taskId)
    const replayed = JSON.parse(String(await ToolFuncRegistry.call(registry, "HolonTaskRepair", vm, actor, request)))
    expect(replayed.replayed).toBe(true)
    expect(replayed.commandId).toBe(repaired.commandId)
    expect(effects).toBe(1)
    expect((await callSlash(`/holon task-observe ${JSON.stringify({ selector })}`)).status).toBe("Succeeded")
    await expect(callSlash('/holon task-repair {"selector":{},"invocation":{}}')).rejects.toThrow()
    expect(effects).toBe(1)
    expect(composeToolRegistry({ includeInternalOnly: false }).list().map((tool) => tool.schema.function.name))
      .toEqual(expect.arrayContaining(["HolonTaskObserve", "HolonTaskRepair"]))
  } finally {
    host.support.close()
    await rm(root, { recursive: true, force: true })
  }
})
