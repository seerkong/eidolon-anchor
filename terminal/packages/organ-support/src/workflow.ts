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
}
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
    return await runtime.callTool(options.toolName, options.input)
  } finally {
    await disposeSessionRuntimeBridge(sessionKey)
  }
}
