import type { WorkflowCreateBundleCommand, WorkflowComponent } from "../../src/workflow"

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
