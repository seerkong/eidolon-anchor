import type { StdInnerLogic } from "depa-processor"
import { spawnChildExecutionActor } from "../../../agent/DelegateActor"
import { assembleWorkflowFulfillmentPrompt } from "../../prompts"
import {
  readInstalledSystemSkillResource,
  resolveEidolonGlobalRootFromOuterContext,
} from "@cell/ai-support/system-skill/SystemSkillInstaller"
import type {
  WorkflowFulfillInnerConfig,
  WorkflowFulfillInnerInput,
  WorkflowFulfillInnerOutput,
  WorkflowFulfillInnerRuntime,
} from "./InnerTypes"

export const workflowFulfillCoreLogic: StdInnerLogic<
  WorkflowFulfillInnerRuntime,
  WorkflowFulfillInnerInput,
  WorkflowFulfillInnerConfig,
  WorkflowFulfillInnerOutput
> = async (runtime, input) => {
  const request = input.request?.trim()
  if (!request) throw new Error("WorkflowFulfill requires an ordinary-language business request")
  const globalRoot = resolveEidolonGlobalRootFromOuterContext(runtime.vm.outerCtx)
  const systemAuthority = await readInstalledSystemSkillResource({
    globalRoot,
    skillName: "sys-ai-workflow",
    relativePath: "SKILL.md",
  }).catch((error) => {
    throw new Error(`Cannot load canonical sys-ai-workflow; run \`eidolon global init\`. ${error instanceof Error ? error.message : String(error)}`)
  })
  return spawnChildExecutionActor(runtime.vm as any, runtime.actor as any, {
    description: "Fulfill a business goal through the Eidolon AI Workflow lifecycle",
    prompt: assembleWorkflowFulfillmentPrompt({
      request,
      operation: input.operation,
      workflowRef: input.workflow_ref,
      publish: input.publish,
      execute: input.execute,
    }),
    agentType: "workflow",
    additionalSystemPrompts: [systemAuthority],
    mode: "sync_wait",
    toolCallId: (runtime as any).toolCallId,
    parentToolName: "WorkflowFulfill",
  })
}
