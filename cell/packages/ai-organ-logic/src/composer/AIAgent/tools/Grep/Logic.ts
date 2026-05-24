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
import type { GrepInnerConfig, GrepInnerInput, GrepInnerOutput, GrepInnerRuntime } from "./InnerTypes"

export const makeGrepOuterComputed = stdMakeNullOuterComputed
export const makeGrepInnerRuntime = stdMakeIdentityInnerRuntime
export const makeGrepInnerInput = stdMakeIdentityInnerInput
export const makeGrepInnerConfig = stdMakeIdentityInnerConfig
export const makeGrepOuterOutput = stdMakeIdentityOuterOutput

export const grepCoreLogic: StdInnerLogic<
  GrepInnerRuntime,
  GrepInnerInput,
  GrepInnerConfig,
  GrepInnerOutput
> = async (runtime, input, _config) => {
  const workdir = runtime.vm.outerCtx.workDir
  if (typeof workdir !== "string" || !workdir.trim()) return "Error: workDir not configured"
  const base = typeof input?.path === "string" && input.path.trim() ? input.path : workdir
  const pattern = String(input?.pattern ?? "")
  if (!pattern.trim()) return "Error: pattern required"
  const permission = authorizeLocalToolCall(runtime, "grep", {
    path: base,
    pattern,
    include: input?.include,
  })
  if (!permission.ok) return permission.output
  const cwd = resolveToolPath(workdir, base)
  const args = ['-n', '--no-heading', pattern]
  if (typeof input?.include === 'string' && input.include.trim()) args.push('-g', input.include)
  args.push('.')
  const res = spawnSync('rg', args, { cwd, encoding: 'utf-8' })
  return `${res.stdout || ''}${res.stderr || ''}`.trim() || '(no matches)'
}
