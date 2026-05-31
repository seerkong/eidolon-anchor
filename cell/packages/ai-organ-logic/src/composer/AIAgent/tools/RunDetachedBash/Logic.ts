import type { StdInnerLogic } from "depa-processor"
import { ensureVmRuntimeContext } from "@cell/ai-core-logic/runtime/runtime"
import {
  DETACHED_ACTOR_KINDS,
  DETACHED_ACTOR_STATUSES,
  getDetachedActorRegistry,
} from "@cell/ai-organ-logic/detached/DetachedActorRegistry"
import {
  executeStreamingSandboxedBashCommand,
  resolveSandboxBackendSelectionFromRuntime,
} from "@cell/ai-organ-logic/sandbox"
import { authorizeLocalToolCall } from "@cell/ai-organ-logic/permissions/LocalPermissionRuntime"
import { getDetachedActorObservabilityStore } from "@cell/ai-organ-logic/detached/DetachedActorObservability"
import path from "path"

import type {
  RunDetachedBashInnerConfig,
  RunDetachedBashInnerInput,
  RunDetachedBashInnerOutput,
  RunDetachedBashInnerRuntime,
} from "./InnerTypes"

function safeJsonRunning(taskId: string): string {
  return JSON.stringify({ task_id: taskId, status: DETACHED_ACTOR_STATUSES.running })
}

function makeTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function resolveTimeoutMs(timeoutSeconds: unknown): number {
  const seconds = Number(timeoutSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return 120000
  return Math.ceil(seconds * 1000)
}

export const runDetachedBashCoreLogic: StdInnerLogic<
  RunDetachedBashInnerRuntime,
  RunDetachedBashInnerInput,
  RunDetachedBashInnerConfig,
  RunDetachedBashInnerOutput
> = async (runtime, input, _config) => {
  try {
    const command = typeof (input as any)?.command === "string" ? String((input as any).command) : ""
    const _agentType = typeof (input as any)?.agent_type === "string" ? String((input as any).agent_type) : ""

    if (!command.trim()) {
      return JSON.stringify({ ok: false, error: "missing_command" })
    }
    if (!_agentType.trim()) {
      return JSON.stringify({ ok: false, error: "missing_agent_type" })
    }

    const permission = authorizeLocalToolCall(runtime, "bash", {
      command,
      timeoutSeconds: (input as any)?.timeoutSeconds,
    })
    if (!permission.ok) return JSON.stringify({ ok: false, error: permission.output })

    const workdirRaw = typeof (input as any)?.workdir === "string" && String((input as any).workdir).trim()
      ? String((input as any).workdir)
      : runtime.vm.outerCtx.workDir
    if (typeof workdirRaw !== "string" || !workdirRaw.trim()) {
      return JSON.stringify({ ok: false, error: "workDir not configured" })
    }

    const cwd = path.isAbsolute(workdirRaw)
      ? workdirRaw
      : path.resolve(String(runtime.vm.outerCtx.workDir ?? process.cwd()), workdirRaw)
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
    if (dangerous.some((item) => command.includes(item))) {
      return JSON.stringify({ ok: false, error: "Dangerous command blocked" })
    }

    const taskId = makeTaskId()
    const registry = getDetachedActorRegistry(runtime.vm)
    registry.create({
      taskId,
      kind: DETACHED_ACTOR_KINDS.bash,
      status: DETACHED_ACTOR_STATUSES.running,
      toolCallId: typeof (runtime as any)?.toolCallId === "string" ? (runtime as any).toolCallId : undefined,
    })
    const store = getDetachedActorObservabilityStore(runtime.vm)
    const selection = resolveSandboxBackendSelectionFromRuntime(runtime, cwd, undefined)
    const timeoutMs = resolveTimeoutMs((input as any)?.timeoutSeconds)

    const taskPromise = executeStreamingSandboxedBashCommand({
      command,
      cwd,
      timeoutMs,
      selection,
      onStdout: (text) => store.appendLog(taskId, { source: "stdout", text }),
      onStderr: (text) => store.appendLog(taskId, { source: "stderr", text }),
    }).then((result) => {
      registry.update(taskId, {
        status: result.ok ? DETACHED_ACTOR_STATUSES.completed : DETACHED_ACTOR_STATUSES.failed,
        outputText: result.outputText,
        error: result.error,
      })
      runtime.vm.eventBus?.emitDetachedActorDone?.(
        { key: runtime.actor.key, id: runtime.actor.id },
        {
          taskId,
          kind: DETACHED_ACTOR_KINDS.bash,
          status: result.ok ? DETACHED_ACTOR_STATUSES.completed : DETACHED_ACTOR_STATUSES.failed,
          toolCallId: typeof (runtime as any)?.toolCallId === "string" ? (runtime as any).toolCallId : undefined,
          outputText: result.outputText,
          error: result.error,
        },
      )
    }).catch((error: any) => {
      const message = String(error?.message ?? error ?? "unknown")
      registry.update(taskId, {
        status: DETACHED_ACTOR_STATUSES.failed,
        outputText: `Error: ${message}`,
        error: message,
      })
    })
    const currentOrchestrator = ensureVmRuntimeContext(runtime.vm).currentOrchestrator as any
    if (typeof currentOrchestrator?.registerBackgroundTask === "function") {
      currentOrchestrator.registerBackgroundTask(taskPromise)
    }

    return safeJsonRunning(taskId)
  } catch (e: any) {
    return JSON.stringify({ ok: false, error: String(e?.message ?? e ?? "unknown") })
  }
}
