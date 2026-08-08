import type { StdInnerLogic } from "depa-processor"
import { createWorkflowComponentForRuntime } from "../../component"
import type {
  WorkflowWorkspaceInnerConfig,
  WorkflowWorkspaceInnerInput,
  WorkflowWorkspaceInnerOutput,
  WorkflowWorkspaceInnerRuntime,
} from "./InnerTypes"

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`WorkflowWorkspace requires ${field}`)
  return value
}

export const workflowWorkspaceCoreLogic: StdInnerLogic<
  WorkflowWorkspaceInnerRuntime,
  WorkflowWorkspaceInnerInput,
  WorkflowWorkspaceInnerConfig,
  WorkflowWorkspaceInnerOutput
> = async (runtime, input) => {
  const component = createWorkflowComponentForRuntime(runtime)
  const workspace = component.authoring
  if (!workspace) throw new Error("Workflow authoring workspace is not bound")

  let result: unknown
  if (input.session_id) {
    const sessionId = requiredText(input.session_id, "session_id")
    switch (input.operation) {
      case "describe":
        result = await component.sessions.describe(sessionId)
        break
      case "tree":
        result = { operation: "tree", files: await component.sessions.tree(sessionId, input.path ?? "/work") }
        break
      case "read":
        result = {
          operation: "read",
          path: requiredText(input.path, "path"),
          content: await component.sessions.read(sessionId, requiredText(input.path, "path")),
        }
        break
      case "search":
        result = {
          operation: "search",
          matches: await component.sessions.search(sessionId, requiredText(input.query, "query"), input.path ?? "/work"),
        }
        break
      case "diff":
        result = await component.sessions.diff(sessionId)
        break
      case "write":
        result = await component.sessions.write(sessionId, requiredText(input.path, "path"), requiredText(input.content, "content"))
        break
      case "edit":
        result = await component.sessions.edit(
          sessionId,
          requiredText(input.path, "path"),
          requiredText(input.old_text, "old_text"),
          typeof input.new_text === "string" ? input.new_text : "",
        )
        break
      case "patch":
        result = await component.sessions.patch(sessionId, requiredText(input.patch, "patch"))
        break
      case "delete":
        result = await component.sessions.delete(sessionId, requiredText(input.path, "path"))
        break
      case "audit":
        result = { operation: "audit", entries: await component.sessions.audit(sessionId) }
        break
      case "validate":
        result = await component.sessions.validate(sessionId)
        break
      default:
        throw new Error(`Unsupported session WorkflowWorkspace operation: ${String(input.operation)}`)
    }
    return JSON.stringify({ ok: true, ...result as object }, null, 2)
  }

  switch (input.operation) {
    case "tree":
      result = { operation: "tree", files: await workspace.tree(input.path) }
      break
    case "read":
      result = {
        operation: "read",
        path: requiredText(input.path, "path"),
        content: await workspace.read(requiredText(input.path, "path")),
      }
      break
    case "search":
      result = {
        operation: "search",
        matches: await workspace.search(requiredText(input.query, "query"), input.path),
      }
      break
    case "diff":
      result = await workspace.diff(
        requiredText(input.path, "path"),
        requiredText(input.content, "content"),
      )
      break
    case "validate": {
      const form = input.form
      if (form !== "AICtrlWorkflow" && form !== "AIDataWorkflow") {
        throw new Error("WorkflowWorkspace validate requires canonical form")
      }
      result = workspace.validate(form, {
        "manifest.xnl": requiredText(input.content, "content"),
      })
      break
    }
    case "write":
    case "delete":
    case "describe":
    case "edit":
    case "patch":
    case "audit":
      throw new Error(`WorkflowWorkspace ${input.operation} requires session_id; published workspace access is read-only`)
    default:
      throw new Error(`Unsupported WorkflowWorkspace operation: ${String(input.operation)}`)
  }
  return JSON.stringify({ ok: true, ...result as object }, null, 2)
}
