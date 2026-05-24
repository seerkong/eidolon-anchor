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
import type { LsInnerConfig, LsInnerInput, LsInnerOutput, LsInnerRuntime } from "./InnerTypes"

export const makeLsOuterComputed = stdMakeNullOuterComputed
export const makeLsInnerRuntime = stdMakeIdentityInnerRuntime
export const makeLsInnerInput = stdMakeIdentityInnerInput
export const makeLsInnerConfig = stdMakeIdentityInnerConfig
export const makeLsOuterOutput = stdMakeIdentityOuterOutput

export const lsCoreLogic: StdInnerLogic<LsInnerRuntime, LsInnerInput, LsInnerConfig, LsInnerOutput> = async (
  runtime,
  input,
  _config,
) => {
  const workdir = runtime.vm.outerCtx.workDir
  if (typeof workdir !== "string" || !workdir.trim()) return "Error: workDir not configured"
  const base = typeof input?.path === "string" && input.path.trim() ? input.path : workdir
  const permission = authorizeLocalToolCall(runtime, "ls", {
    path: base,
    ignore: input?.ignore,
  })
  if (!permission.ok) return permission.output
  const dir = resolveToolPath(workdir, base)
  const ignores = new Set((input?.ignore ?? []).map((x) => String(x)))
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .map((entry) => entry.name + (entry.isDirectory() ? "/" : ""))
    .filter((entry) => !ignores.has(entry) && !ignores.has(entry.replace(/\/$/, "")))
    .sort()
  return entries.join("\n") || "(empty directory)"
}
