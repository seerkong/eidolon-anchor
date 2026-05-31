import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import path from "path"
import { authorizeLocalToolCall } from "@cell/ai-organ-logic/permissions/LocalPermissionRuntime"
import { ensureVmRuntimeContext } from "@cell/ai-core-logic/runtime/runtime"
import { getDetachedActorObservabilityStore } from "@cell/ai-organ-logic/detached/DetachedActorObservability"
import {
  executeSandboxedBashCommand,
  executeStreamingSandboxedBashCommand,
  resolveSandboxBackendSelectionFromRuntime,
  type SpawnSyncLike,
} from "@cell/ai-organ-logic/sandbox"
import type { BashInnerConfig, BashInnerInput, BashInnerOutput, BashInnerRuntime } from "./InnerTypes"

export const makeBashOuterComputed = stdMakeNullOuterComputed
export const makeBashInnerRuntime = stdMakeIdentityInnerRuntime
export const makeBashInnerInput = stdMakeIdentityInnerInput
export const makeBashInnerConfig = stdMakeIdentityInnerConfig
export const makeBashOuterOutput = stdMakeIdentityOuterOutput

function resolveTimeoutMs(timeoutSeconds: unknown): number {
  const seconds = Number(timeoutSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return 120000
  return Math.ceil(seconds * 1000)
}

export const bashCoreLogic: StdInnerLogic<BashInnerRuntime, BashInnerInput, BashInnerConfig, BashInnerOutput> = async (runtime, input, _config) => {
  const command = String(input?.command ?? "")
  if (!command.trim()) return "Error: command required"
  const permission = authorizeLocalToolCall(runtime, "bash", {
    command,
    workdir: typeof input?.workdir === "string" ? input.workdir : undefined,
    timeoutSeconds: input?.timeoutSeconds,
  })
  if (!permission.ok) return permission.output
  const workdirRaw = typeof input?.workdir === "string" && input.workdir.trim() ? input.workdir : runtime.vm.outerCtx.workDir
  if (typeof workdirRaw !== "string" || !workdirRaw.trim()) return "Error: workDir not configured"
  const cwd = path.isAbsolute(workdirRaw) ? workdirRaw : path.resolve(String(runtime.vm.outerCtx.workDir ?? process.cwd()), workdirRaw)
  const timeoutMs = resolveTimeoutMs(input?.timeoutSeconds)
  try {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
    if (dangerous.some((item) => command.includes(item))) {
      return "Error: Dangerous command blocked"
    }
    const selection = resolveSandboxBackendSelectionFromRuntime(runtime, cwd, typeof _config?.platform === "string" ? String(_config.platform) : undefined)
    const currentFiberId = ensureVmRuntimeContext(runtime.vm).currentOrchestrator?.parentFiberId
    const store = getDetachedActorObservabilityStore(runtime.vm)
    const detachedTaskId = typeof currentFiberId === "string" ? store.getTaskIdForFiber(currentFiberId) : null
    // Tests can inject a sync spawn override via _config.spawnSyncFn.
    // In production we use async spawn so the event loop stays responsive
    // during long-running commands.
    const spawnSyncOverride: SpawnSyncLike | undefined =
      typeof _config?.spawnSyncFn === "function" ? (_config.spawnSyncFn as SpawnSyncLike) : undefined
    if (spawnSyncOverride) {
      // Test path: use synchronous spawnSync (blocks event loop, acceptable for tests)
      return executeSandboxedBashCommand({
        command,
        cwd,
        timeoutMs,
        selection,
        spawnSyncFn: spawnSyncOverride,
      })
    }

    // Production path: use async spawn to avoid blocking the event loop
    const result = await executeStreamingSandboxedBashCommand({
      command,
      cwd,
      timeoutMs,
      selection,
      signal: (runtime as any)?.signal instanceof AbortSignal ? (runtime as any).signal : undefined,
      ...(detachedTaskId
        ? {
            onStdout: (text: string) => store.appendLog(detachedTaskId, { source: "stdout", text }),
            onStderr: (text: string) => store.appendLog(detachedTaskId, { source: "stderr", text }),
          }
        : {}),
    })
    if (result.error) return `Error: ${result.error}`
    if (result.timedOut) return `Error: bash command timed out after ${timeoutMs}ms`
    return result.outputText
  } catch (e: any) {
    return `Error: ${e.message}`
  }
}
