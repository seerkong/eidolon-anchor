import type { StdInnerLogic } from "depa-processor"
import { spawnChildExecutionActor } from "../../../agent/DelegateActor"
import { assembleWorkflowAuthorPrompt } from "../../prompts"
import {
  readInstalledSystemSkillResource,
  resolveEidolonGlobalRootFromOuterContext,
} from "@cell/ai-support/system-skill/SystemSkillInstaller"
import type {
  WorkflowAuthorInnerConfig,
  WorkflowAuthorInnerInput,
  WorkflowAuthorInnerOutput,
  WorkflowAuthorInnerRuntime,
} from "./InnerTypes"

export const workflowAuthorCoreLogic: StdInnerLogic<
  WorkflowAuthorInnerRuntime,
  WorkflowAuthorInnerInput,
  WorkflowAuthorInnerConfig,
  WorkflowAuthorInnerOutput
> = async (runtime, input) => {
  const request = input.request?.trim()
  if (!request) throw new Error("WorkflowAuthor requires a natural-language request")
  if (input.operation === "edit" && !input.workflow_ref?.trim()) {
    throw new Error("WorkflowAuthor edit requires workflow_ref")
  }
  const globalRoot = resolveEidolonGlobalRootFromOuterContext(runtime.vm.outerCtx)
  const systemAuthority = await readInstalledSystemSkillResource({
    globalRoot,
    skillName: "sys-eidolon-anchor-devops",
    relativePath: "SKILL.md",
  }).catch((error) => {
    throw new Error(`Cannot load canonical sys-eidolon-anchor-devops; run \`eidolon global init\`. ${error instanceof Error ? error.message : String(error)}`)
  })
  return spawnChildExecutionActor(runtime.vm as any, runtime.actor as any, {
    description: input.operation === "edit" ? "Edit an AI workflow" : "Create an AI workflow",
    prompt: assembleWorkflowAuthorPrompt({
      operation: input.operation,
      request,
      workflowRef: input.workflow_ref,
      form: input.form,
      publish: input.publish,
    }),
    agentType: "workflow",
    additionalSystemPrompts: [systemAuthority],
    mode: "sync_wait",
    toolCallId: (runtime as any).toolCallId,
  })
}
