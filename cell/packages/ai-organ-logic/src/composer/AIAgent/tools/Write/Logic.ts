import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import fs from "fs"
import path from "path"
import { authorizeLocalToolCall } from "@cell/ai-organ-logic/permissions/LocalPermissionRuntime"
import { resolveToolPath } from "../_shared"
import type { WriteInnerConfig, WriteInnerInput, WriteInnerOutput, WriteInnerRuntime } from "./InnerTypes"

export const makeWriteOuterComputed = stdMakeNullOuterComputed
export const makeWriteInnerRuntime = stdMakeIdentityInnerRuntime
export const makeWriteInnerInput = stdMakeIdentityInnerInput
export const makeWriteInnerConfig = stdMakeIdentityInnerConfig
export const makeWriteOuterOutput = stdMakeIdentityOuterOutput

export const writeCoreLogic: StdInnerLogic<
  WriteInnerRuntime,
  WriteInnerInput,
  WriteInnerConfig,
  WriteInnerOutput
> = async (runtime, input, _config) => {
  const workdir = runtime.vm.outerCtx.workDir
  if (typeof workdir !== "string" || !workdir.trim()) return "Error: workDir not configured"
  const rawPath = String(input?.filePath ?? "")
  if (!rawPath.trim()) return "Error: filePath required"
  const permission = authorizeLocalToolCall(runtime, "write", {
    filePath: rawPath,
    content: input?.content,
  })
  if (!permission.ok) return permission.output
  const full = resolveToolPath(workdir, rawPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, String(input?.content ?? ""), "utf-8")
  return `Wrote file successfully.`
}
