import type { StdInnerLogic } from "depa-processor"
import { createWorkflowComponentForRuntime } from "../../component"
import { WorkflowAuthoringVfsError } from "../../authoring/WorkflowAuthoringSessionStore"
import { withWorkflowDomainProgress } from "../../runtime/WorkflowDomainProgress"
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

function requiredPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    throw new Error("WorkflowWorkspace read_many requires 1 to 12 paths")
  }
  if (
    Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length > 0
    || Object.keys(value).length !== value.length
  ) {
    throw new Error("WorkflowWorkspace read_many paths must be a dense plain array")
  }
  const paths = Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("WorkflowWorkspace read_many paths must contain only enumerable data items")
    }
    return requiredText(descriptor.value, `paths[${index}]`)
  })
  if (new Set(paths).size !== paths.length) {
    throw new Error("WorkflowWorkspace read_many paths must be unique")
  }
  return paths
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
  try {
    if (input.session_id) {
      const sessionId = requiredText(input.session_id, "session_id")
      const mutationRequested = input.operation === "write"
        || input.operation === "edit"
        || input.operation === "patch"
        || input.operation === "delete"
      const revisionBefore = mutationRequested
        ? (await component.sessions.describe(sessionId)).workingRevision
        : undefined
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
        case "read_selection":
          result = await component.sessions.readResourcePackageSelection(sessionId)
          break
        case "read_many": {
          const paths = requiredPaths(input.paths)
          result = {
            operation: "read_many",
            files: await Promise.all(paths.map(async (filePath) => ({
              path: filePath,
              content: await component.sessions.read(sessionId, filePath),
            }))),
          }
          break
        }
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
          result = Array.isArray(input.operations)
            ? await component.sessions.applyPatch({
                sessionId,
                expectedWorkingRevision: requiredText(input.expected_revision, "expected_revision"),
                operations: input.operations,
              })
            : await component.sessions.patch(sessionId, requiredText(input.patch, "patch"))
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
      const envelope = { ok: true, ...result as object }
      if (mutationRequested) {
        const changed = await component.sessions.describe(sessionId)
        if (changed.workingRevision === revisionBefore) return JSON.stringify(envelope, null, 2)
        return JSON.stringify(withWorkflowDomainProgress(envelope, {
          owner: "workflow.authoring",
          transition: "workspace_revision_changed",
          subjectId: sessionId,
          revision: changed.workingRevision,
        }), null, 2)
      }
      return JSON.stringify(envelope, null, 2)
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
      case "read_many":
      case "read_selection":
        throw new Error(`WorkflowWorkspace ${input.operation} requires session_id; published workspace access is read-only`)
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
  } catch (error) {
    if (error instanceof WorkflowAuthoringVfsError) {
      return JSON.stringify({ ok: false, diagnostic: error.diagnostic }, null, 2)
    }
    throw error
  }
}
