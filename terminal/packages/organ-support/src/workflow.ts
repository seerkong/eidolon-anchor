import { createHash } from "node:crypto"
import path from "node:path"

import {
  buildExecRuntimeMetadata,
  configureSessionRuntime,
  disposeSessionRuntimeBridge,
  getSessionRuntimeBridge,
} from "@terminal/organ/AIAgent/TerminalRuntime"

export type NativeWorkflowToolOptions = {
  workDir: string
  toolName: string
  input: unknown
  adapter?: string
  model?: string
  profile?: string
  timeoutSeconds?: number
  sessionKey?: string
  captureRuntimeEvidence?: boolean
}

export type NativeWorkflowToolEvidenceResult = Readonly<{
  kind: "workflow.nativeToolEvidenceResult"
  status: "completed"
  output: unknown
  timing: unknown
  usage: unknown
  providerCacheObservations: readonly unknown[]
  workflowExecutions: readonly unknown[]
}>
export function workflowSessionKey(workDir: string): string {
  const canonical = path.resolve(workDir)
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 20)
  return `workflow-${digest}`
}

export async function runNativeWorkflowTool(options: NativeWorkflowToolOptions): Promise<unknown> {
  const workDir = path.resolve(options.workDir)
  const sessionKey = options.sessionKey?.trim() || workflowSessionKey(workDir)
  configureSessionRuntime({
    workDir,
    adapter: options.adapter,
    model: options.model,
    timeoutSeconds: options.timeoutSeconds,
    mcp: false,
    ephemeral: false,
    profileId: options.profile,
    entryType: "cli",
    metadata: buildExecRuntimeMetadata({
      workDir,
      approvalMode: "full-auto",
    }),
  })
  const runtime = await getSessionRuntimeBridge(sessionKey)
  if (!runtime) throw new Error("Runtime unavailable: failed to initialize Eidolon workflow session")
  try {
    const startedAt = Date.now()
    const providerObservationCountBefore = runtime.readProviderCacheObservations?.().length ?? 0
    const workflowExecutionCountBefore = runtime.readWorkflowExecutions?.().length ?? 0
    const output = await runtime.callWorkflowHostCommand(options.toolName, options.input)
    if (!options.captureRuntimeEvidence) return output
    const endedAt = Date.now()
    return Object.freeze({
      kind: "workflow.nativeToolEvidenceResult",
      status: "completed",
      output,
      timing: runtime.readTimingProjection?.({ startedAt, endedAt }) ?? null,
      usage: runtime.readUsageProjection?.() ?? null,
      providerCacheObservations: Object.freeze([
        ...(runtime.readProviderCacheObservations?.() ?? []).slice(providerObservationCountBefore),
      ]),
      workflowExecutions: Object.freeze([
        ...(runtime.readWorkflowExecutions?.() ?? []).slice(workflowExecutionCountBefore),
      ]),
    }) satisfies NativeWorkflowToolEvidenceResult
  } finally {
    await disposeSessionRuntimeBridge(sessionKey)
  }
}
