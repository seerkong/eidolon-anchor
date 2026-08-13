import type { StdInnerLogic } from "depa-processor"
import { createWorkflowComponentForRuntime } from "../../component"
import type {
  WorkflowCreateBundleInnerConfig,
  WorkflowCreateBundleInnerInput,
  WorkflowCreateBundleInnerOutput,
  WorkflowCreateBundleInnerRuntime,
} from "./InnerTypes"

export const workflowCreateBundleCoreLogic: StdInnerLogic<
  WorkflowCreateBundleInnerRuntime,
  WorkflowCreateBundleInnerInput,
  WorkflowCreateBundleInnerConfig,
  WorkflowCreateBundleInnerOutput
> = async (runtime, input, _config) => {
  const component = createWorkflowComponentForRuntime(runtime)
  const draft = component.commands.createBundleDraft(input)
  if (input.dry_run) return JSON.stringify(draft, null, 2)
  const bundlePath = draft.files[0]!.path.split("/")[0]!
  const prefix = `${bundlePath}/`
  const session = await component.sessions.open({
    sessionId: input.session_id,
    form: draft.form,
    template: draft.files.map((file) => ({
      path: file.path.slice(prefix.length),
      content: file.content,
    })),
    target: { scope: "definition", id: draft.fqn, path: bundlePath, resourceRef: draft.resourceRef },
  })
  const result = {
    kind: "workflow.authoringDraft",
    status: "session_opened",
    draft: {
      ...draft,
      files: draft.files.map((file) => ({
        path: file.path,
        ref: file.ref,
        sizeBytes: Buffer.byteLength(file.content, "utf8"),
      })),
    },
    session,
    persistence: {
      authoringSessionMaterialized: true,
      scope: "authoring_session",
      publicationPerformed: false,
      executionPerformed: false,
      note: "The draft generator itself is side-effect free, but this authoring session and its /work files are durably stored.",
    },
    effectDispatched: false,
  }
  return JSON.stringify(result, null, 2)
}
