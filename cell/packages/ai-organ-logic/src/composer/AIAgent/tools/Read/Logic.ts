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
  const offset = Math.max(1, Number(input?.offset ?? 1))

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(full).sort()
    const limit = Math.max(1, Number(input?.limit ?? 200))
    return entries.slice(offset - 1, offset - 1 + limit).join("\n")
  }

  const lines = fs.readFileSync(full, "utf-8").split(/\r?\n/)
  const limit = Math.max(1, Number(input?.limit ?? 2000))
  return lines
    .slice(offset - 1, offset - 1 + limit)
    .map((line, idx) => `${offset + idx}: ${line}`)
    .join("\n")
}
