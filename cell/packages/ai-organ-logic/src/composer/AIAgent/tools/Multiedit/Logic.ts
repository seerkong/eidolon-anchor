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
import { applyStringEdit, buildUnifiedDiff, encodeFileEditResult, formatEditNotFoundError } from "../_file-editing"
import type { MultieditInnerConfig, MultieditInnerInput, MultieditInnerOutput, MultieditInnerRuntime } from "./InnerTypes"

export const makeMultieditOuterComputed = stdMakeNullOuterComputed
export const makeMultieditInnerRuntime = stdMakeIdentityInnerRuntime
export const makeMultieditInnerInput = stdMakeIdentityInnerInput
export const makeMultieditInnerConfig = stdMakeIdentityInnerConfig
export const makeMultieditOuterOutput = stdMakeIdentityOuterOutput

export const multieditCoreLogic: StdInnerLogic<
  MultieditInnerRuntime,
  MultieditInnerInput,
  MultieditInnerConfig,
  MultieditInnerOutput
> = async (runtime, input, _config) => {
  const workdir = runtime.vm.outerCtx.workDir
  if (typeof workdir !== "string" || !workdir.trim()) return "Error: workDir not configured"
  const rawPath = String(input?.filePath ?? "")
  if (!rawPath.trim()) return "Error: filePath required"
  const permission = authorizeLocalToolCall(runtime, "multiedit", {
    filePath: rawPath,
    edits: input?.edits,
  })
  if (!permission.ok) return permission.output
  const full = resolveToolPath(workdir, rawPath)
  const originalContent = fs.readFileSync(full, "utf-8")
  let content = originalContent
  let appliedCount = 0
  for (const [index, edit] of (input?.edits ?? []).entries()) {
    const oldString = String(edit?.oldString ?? "")
    const newString = String(edit?.newString ?? "")
    if (!oldString) continue
    const applied = applyStringEdit({
      content,
      oldString,
      newString,
      replaceAll: edit?.replaceAll,
    })
    if (!applied.ok) {
      return formatEditNotFoundError(rawPath, applied, index)
    }
    content = applied.next
    appliedCount += 1
  }
  fs.writeFileSync(full, content, "utf-8")
  return encodeFileEditResult({
    message: `Edited ${rawPath}${appliedCount > 1 ? ` (${appliedCount} edits)` : ""}`,
    filePath: rawPath,
    diff: buildUnifiedDiff(rawPath, originalContent, content),
  })
}
