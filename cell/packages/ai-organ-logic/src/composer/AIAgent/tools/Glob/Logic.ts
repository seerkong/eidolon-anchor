import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { spawnSync } from "child_process"
import { authorizeLocalToolCall } from "@cell/ai-organ-logic/permissions/LocalPermissionRuntime"
import { resolveToolPath } from "../_shared"
import type { GlobInnerConfig, GlobInnerInput, GlobInnerOutput, GlobInnerRuntime } from "./InnerTypes"

export const makeGlobOuterComputed = stdMakeNullOuterComputed
export const makeGlobInnerRuntime = stdMakeIdentityInnerRuntime
export const makeGlobInnerInput = stdMakeIdentityInnerInput
export const makeGlobInnerConfig = stdMakeIdentityInnerConfig
export const makeGlobOuterOutput = stdMakeIdentityOuterOutput

export const globCoreLogic: StdInnerLogic<
  GlobInnerRuntime,
  GlobInnerInput,
  GlobInnerConfig,
  GlobInnerOutput
> = async (runtime, input, _config) => {
  const workdir = runtime.vm.outerCtx.workDir
  if (typeof workdir !== "string" || !workdir.trim()) return "Error: workDir not configured"
  const base = typeof input?.path === "string" && input.path.trim() ? input.path : workdir
  const pattern = String(input?.pattern ?? "")
  if (!pattern.trim()) return "Error: pattern required"
  const permission = authorizeLocalToolCall(runtime, "glob", {
    path: base,
    pattern,
  })
  if (!permission.ok) return permission.output
  const cwd = resolveToolPath(workdir, base)
  const res = spawnSync('rg', ['--files', '-g', pattern], { cwd, encoding: 'utf-8' })
  return `${res.stdout || ''}${res.stderr || ''}`.trim() || '(no matches)'
}
