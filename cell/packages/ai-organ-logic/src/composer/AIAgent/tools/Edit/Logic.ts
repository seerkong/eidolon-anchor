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
import { applyStringEdit, buildUnifiedDiff, encodeFileEditResult, formatEditNotFoundError, trimDiff } from "../_file-editing"
import type { EditInnerConfig, EditInnerInput, EditInnerOutput, EditInnerRuntime } from "./InnerTypes"

export { trimDiff } from "../_file-editing"

export const makeEditOuterComputed = stdMakeNullOuterComputed
export const makeEditInnerRuntime = stdMakeIdentityInnerRuntime
export const makeEditInnerInput = stdMakeIdentityInnerInput
export const makeEditInnerConfig = stdMakeIdentityInnerConfig
export const makeEditOuterOutput = stdMakeIdentityOuterOutput

export const editCoreLogic: StdInnerLogic<
  EditInnerRuntime,
  EditInnerInput,
  EditInnerConfig,
  EditInnerOutput
> = async (runtime, input, _config) => {
  const workdir = runtime.vm.outerCtx.workDir
  if (typeof workdir !== "string" || !workdir.trim()) return "Error: workDir not configured"
  const rawPath = String(input?.filePath ?? "")
  const oldString = String(input?.oldString ?? "")
  const newString = String(input?.newString ?? "")
  if (!rawPath.trim() || !oldString) return "Error: filePath and oldString required"
  const permission = authorizeLocalToolCall(runtime, "edit", {
    filePath: rawPath,
    oldString,
    newString,
    replaceAll: input?.replaceAll,
  })
  if (!permission.ok) return permission.output
  const full = resolveToolPath(workdir, rawPath)
  const content = fs.readFileSync(full, "utf-8")
  const applied = applyStringEdit({
    content,
    oldString,
    newString,
    replaceAll: input?.replaceAll,
  })
  if (!applied.ok) {
    return formatEditNotFoundError(rawPath, applied)
  }
  const next = applied.next
  const diff = buildUnifiedDiff(rawPath, content, next)
  fs.writeFileSync(full, next, "utf-8")
  return encodeFileEditResult({
    message: `Edited ${rawPath}`,
    filePath: rawPath,
    diff,
  })
}
