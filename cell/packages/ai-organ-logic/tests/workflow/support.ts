import type { WorkflowCreateBundleCommand, WorkflowComponent } from "../../src/workflow"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { composeToolRegistry } from "../../src/composer/AIAgent"
import {
  createWorkflowLifecycleFacetEnvelope,
  createWorkflowLifecycleFacetRegistry,
} from "../../src/workflow/runtime/WorkflowLifecycleFacet"
import { AI_WORKFLOW_PROVIDER_TOOL_SURFACE } from "../../src/workflow/tools/WorkflowLoadStageContext/StageToolPolicy"
import { createWorkflowLifecycleToolProfileRegistry } from "../../src/workflow/tools"

const WORKFLOW_TEST_SKILL = [
  "---",
  "name: sys-eidolon-anchor-devops",
  "revision: workflow-test-fixture-v1",
  "---",
  "# Workflow lifecycle test authority",
].join("\n")

/**
 * Unit/integration fixture for tests that intentionally invoke lifecycle-only
 * tools directly. Ordinary actors see only WorkflowFulfill/WorkflowAuthor;
 * direct lifecycle calls must carry the same facet/profile proof as the real
 * Workflow lifecycle Actor.
 */
export function createAdmittedWorkflowToolTestFixture(key = "workflow-test") {
  const profileRegistry = createWorkflowLifecycleToolProfileRegistry()
  const actor = createActor({
    key,
    systemPrompts: [WORKFLOW_TEST_SKILL],
    runtimeFacets: [createWorkflowLifecycleFacetEnvelope({
      strategyRevision: "stable-superset/v1",
      systemPrompts: [WORKFLOW_TEST_SKILL],
      toolNames: AI_WORKFLOW_PROVIDER_TOOL_SURFACE,
      progress: {
        stageStartedAt: 1,
        deadlineAt: Number.MAX_SAFE_INTEGER,
        turnsSinceProgress: 0,
        maxNoProgressTurns: 100,
        proofRepairAttempts: 0,
        maxProofRepairAttempts: 100,
        lastProgressAt: 1,
      },
    })],
  })
  const toolRegistry = composeToolRegistry({
    includeInternalOnly: true,
    includeWorkflowLifecycle: true,
    workflowProfileRegistry: profileRegistry,
  })
  return {
    actor,
    toolRegistry,
    profileRegistry,
    actorFacetRuntime: createWorkflowLifecycleFacetRegistry(),
  }
}

export async function publishWorkflowFixture(
  component: WorkflowComponent,
  command: WorkflowCreateBundleCommand,
  sessionId?: string,
) {
  const draft = component.commands.createBundleDraft(command)
  const bundlePath = draft.files[0]!.path.split("/")[0]!
  const prefix = `${bundlePath}/`
  const session = await component.sessions.open({
    sessionId,
    form: draft.form,
    template: draft.files.map((file) => ({
      path: file.path.slice(prefix.length),
      content: file.content,
    })),
    target: {
      scope: "definition",
      id: draft.name,
      path: bundlePath,
      workflowRef: draft.workflowRef,
    },
  })
  const diff = await component.sessions.diff(session.sessionId)
  const validation = await component.sessions.validate(session.sessionId)
  const dryRun = await component.sessions.dryRun(session.sessionId)
  const published = await component.sessions.publish({ sessionId: session.sessionId, confirmed: true })
  return { draft, bundlePath, session, diff, validation, dryRun, published }
}
