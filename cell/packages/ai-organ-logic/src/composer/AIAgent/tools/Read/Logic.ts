import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import fs from "fs"
import { authorizeLocalToolCall } from "@cell/ai-organ-logic/permissions/LocalPermissionRuntime"
import { loadLocalTextResource } from "@cell/ai-organ-logic/runtime/LocalTextResourceLoader"
import { resolveToolPath } from "../_shared"
import type { ReadInnerConfig, ReadInnerInput, ReadInnerOutput, ReadInnerRuntime } from "./InnerTypes"

export const makeReadOuterComputed = stdMakeNullOuterComputed
export const makeReadInnerRuntime = stdMakeIdentityInnerRuntime
export const makeReadInnerInput = stdMakeIdentityInnerInput
export const makeReadInnerConfig = stdMakeIdentityInnerConfig
export const makeReadOuterOutput = stdMakeIdentityOuterOutput

export const readCoreLogic: StdInnerLogic<ReadInnerRuntime, ReadInnerInput, ReadInnerConfig, ReadInnerOutput> = async (
  runtime,
  input,
  _config,
) => {
  const workdir = runtime.vm.outerCtx.workDir
  if (typeof workdir !== "string" || !workdir.trim()) return "Error: workDir not configured"
  const rawPath = String(input?.filePath ?? "")
  if (!rawPath.trim()) return "Error: filePath required"
  const permission = authorizeLocalToolCall(runtime, "read", {
    filePath: rawPath,
    offset: input?.offset,
    limit: input?.limit,
  })
  if (!permission.ok) return permission.output
  const full = resolveToolPath(workdir, rawPath)
  const stat = fs.statSync(full)
  const offset = Number(input?.offset ?? 1)

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(full).sort()
    const directoryOffset = Math.max(1, offset)
    const limit = Math.max(1, Number(input?.limit ?? 200))
    return entries.slice(directoryOffset - 1, directoryOffset - 1 + limit).join("\n")
  }

  return loadLocalTextResource({
    vm: runtime.vm,
    actorKey: runtime.actor.key,
    actorId: runtime.actor.id,
    toolCallId: String((runtime as any).toolCallId ?? ""),
    fullPath: full,
    sourceText: fs.readFileSync(full, "utf-8"),
    offset,
    limit: Number(input?.limit ?? 2000),
  })
}
