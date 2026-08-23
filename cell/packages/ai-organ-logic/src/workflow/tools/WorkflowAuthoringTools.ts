import type { AiAgentOneActorRuntime, ToolDef } from "@cell/ai-core-contract/types"
import type { AiWorkflowForm } from "@cell/ai-workflow-contract"
import { createWorkflowComponentForRuntime } from "../component"
import {
  hashWorkflowBinaryFiles,
  projectWorkflowAuthoringSessionPage,
  projectWorkflowAuthoringSummary,
} from "../authoring"
import { withWorkflowDomainProgress } from "../runtime/WorkflowDomainProgress"
import { normalizeWorkflowFulfillmentContinuation } from "./WorkflowFulfill/OuterTypes"

type ToolConfig = Record<string, unknown>
type JsonTool = ToolDef<any, string, ToolConfig>

function json(value: unknown): string {
  return JSON.stringify({ ok: true, ...value as object }, null, 2)
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

function form(value: unknown): AiWorkflowForm {
  if (value === "AICtrlWorkflow" || value === "ai-ctrl") return "AICtrlWorkflow"
  if (value === "AIDataWorkflow" || value === "ai-data") return "AIDataWorkflow"
  throw new Error("workflow form is required")
}

function explicitCompletePackageFiles(value: unknown): Array<{ path: string; bytes: Uint8Array }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new Error("ResourcePackage explicit files must contain between 1 and 128 entries")
  }
  const files: Array<{ path: string; bytes: Uint8Array }> = []
  for (let index = 0; index < value.length; index += 1) {
    const arrayDescriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!arrayDescriptor || !("value" in arrayDescriptor) || !arrayDescriptor.enumerable) {
      throw new Error(`ResourcePackage explicit files[${index}] must be one dense data entry`)
    }
    const entry = arrayDescriptor.value
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`ResourcePackage explicit files[${index}] must be one plain object`)
    }
    const prototype = Object.getPrototypeOf(entry)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`ResourcePackage explicit files[${index}] must be one plain object`)
    }
    if (Object.getOwnPropertySymbols(entry).length > 0) {
      throw new Error(`ResourcePackage explicit files[${index}] contains unsupported fields`)
    }
    const names = Object.getOwnPropertyNames(entry)
    if (names.length !== 2 || !names.includes("path") || !names.includes("content")) {
      throw new Error(`ResourcePackage explicit files[${index}] fields must be path and content`)
    }
    const pathDescriptor = Object.getOwnPropertyDescriptor(entry, "path")
    const contentDescriptor = Object.getOwnPropertyDescriptor(entry, "content")
    if (
      !pathDescriptor || !("value" in pathDescriptor) || !pathDescriptor.enumerable
      || !contentDescriptor || !("value" in contentDescriptor) || !contentDescriptor.enumerable
    ) {
      throw new Error(`ResourcePackage explicit files[${index}] fields must be enumerable data fields`)
    }
    const filePath = text(pathDescriptor.value, `files[${index}].path`)
    if (typeof contentDescriptor.value !== "string") {
      throw new Error(`files[${index}].content must be a string`)
    }
    files.push({ path: filePath, bytes: new TextEncoder().encode(contentDescriptor.value) })
  }
  return files
}

function boundedResourceDiagnostics(error: unknown): Array<{ code: string; location: string; message: string }> | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(error, "diagnostics")
  if (descriptor && "value" in descriptor && Array.isArray(descriptor.value)) {
    const diagnostics: Array<{ code: string; location: string; message: string }> = []
    for (let index = 0; index < Math.min(descriptor.value.length, 20); index += 1) {
      const item = descriptor.value[index]
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue
      const code = Object.getOwnPropertyDescriptor(item, "code")
      const location = Object.getOwnPropertyDescriptor(item, "location")
      const message = Object.getOwnPropertyDescriptor(item, "message")
      if (
        !code || !("value" in code) || typeof code.value !== "string"
        || !location || !("value" in location) || typeof location.value !== "string"
        || !message || !("value" in message) || typeof message.value !== "string"
      ) continue
      diagnostics.push({ code: code.value, location: location.value, message: message.value })
    }
    return diagnostics.length > 0 ? diagnostics : undefined
  }

  const vfsDescriptor = Object.getOwnPropertyDescriptor(error, "diagnostic")
  if (!vfsDescriptor || !("value" in vfsDescriptor)) return undefined
  const diagnostic = vfsDescriptor.value
  if (typeof diagnostic !== "object" || diagnostic === null || Array.isArray(diagnostic)) return undefined
  const kind = Object.getOwnPropertyDescriptor(diagnostic, "kind")
  const code = Object.getOwnPropertyDescriptor(diagnostic, "code")
  const operation = Object.getOwnPropertyDescriptor(diagnostic, "operation")
  const filePath = Object.getOwnPropertyDescriptor(diagnostic, "path")
  const expected = Object.getOwnPropertyDescriptor(diagnostic, "expected")
  const actual = Object.getOwnPropertyDescriptor(diagnostic, "actual")
  if (
    !kind || !("value" in kind) || kind.value !== "workflow.authoringVfsDiagnostic"
    || !code || !("value" in code) || (code.value !== "not_found" && code.value !== "operation_mismatch")
    || !operation || !("value" in operation) || typeof operation.value !== "string"
    || !filePath || !("value" in filePath) || typeof filePath.value !== "string"
    || !expected || !("value" in expected) || typeof expected.value !== "string"
    || !actual || !("value" in actual) || typeof actual.value !== "string"
  ) return undefined
  return [{
    code: `WORKFLOW_AUTHORING_VFS_${String(code.value).toUpperCase()}`,
    location: filePath.value,
    message: `${operation.value} expected ${expected.value}, found ${actual.value}`,
  }]
}

function outerSessionId(runtime: AiAgentOneActorRuntime): string | undefined {
  const value = (runtime.vm.outerCtx?.metadata as Record<string, unknown> | undefined)?.sessionId
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

async function activeAuthoringIdentity(
  runtime: AiAgentOneActorRuntime,
  input: { session_id?: unknown; expected_revision?: unknown },
  component: ReturnType<typeof createWorkflowComponentForRuntime>,
): Promise<{ sessionId: string; revision?: string }> {
  const progress = runtime.actor.workflowProgress
  let sessionId = input.session_id === undefined
    ? progress?.activeAuthoringSessionId
    : text(input.session_id, "session_id")
  let revision = input.expected_revision === undefined
    ? progress?.activeAuthoringRevision
    : text(input.expected_revision, "expected_revision")
  if (!sessionId) {
    const outerId = outerSessionId(runtime)
    const continuation = outerId
      ? await component.sessions.readFulfillmentContinuation(outerId)
      : undefined
    if (continuation?.kind === "authoring") {
      sessionId = continuation.authoring_session_id
      revision ??= continuation.expected_revision
    }
  }
  if (!sessionId) throw new Error("active workflow authoring session is not available")
  return { sessionId, revision }
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  run: (runtime: AiAgentOneActorRuntime, input: any) => Promise<unknown> | unknown,
): JsonTool {
  return toolWithParameters(
    name,
    description,
    { type: "object", properties, required, additionalProperties: false },
    run,
  )
}

function toolWithParameters(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  run: (runtime: AiAgentOneActorRuntime, input: any) => Promise<unknown> | unknown,
): JsonTool {
  return {
    schema: {
      type: "function",
      function: {
        name,
        description,
        parameters,
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime, input) => json(await run(runtime, input)),
  }
}

export function buildWorkflowGetAuthoringContextToolDef(): JsonTool {
  return tool(
    "WorkflowGetAuthoringContext",
    "Load versioned native workflow authoring or run context without dispatching effects.",
    { stage: { type: "string", enum: ["definition", "run"] } },
    ["stage"],
    (runtime, input) => createWorkflowComponentForRuntime(runtime).catalog.getContext(input.stage),
  )
}

export function buildWorkflowListAuthoringTemplatesToolDef(): JsonTool {
  return tool(
    "WorkflowListAuthoringTemplates",
    "List installed canonical XNL workflow authoring templates.",
    {},
    [],
    (runtime) => ({ templates: createWorkflowComponentForRuntime(runtime).catalog.listTemplates(), effectDispatched: false }),
  )
}

export function buildWorkflowListPrebuiltWorkflowsToolDef(): JsonTool {
  return tool(
    "WorkflowListPrebuiltWorkflows",
    "List installed reusable workflow starting facts without loading hidden prompt bodies.",
    {},
    [],
    (runtime) => ({ workflows: createWorkflowComponentForRuntime(runtime).catalog.listPrebuiltWorkflows(), effectDispatched: false }),
  )
}

export function buildWorkflowListReusableAgentsToolDef(): JsonTool {
  return tool(
    "WorkflowListReusableAgents",
    "List bounded prompt-free briefs for reusable Agent resources in the current Halfcode registry snapshot.",
    {},
    [],
    async (runtime) => ({
      agents: await createWorkflowComponentForRuntime(runtime).queries.listReusableAgents(),
      effectDispatched: false,
    }),
  )
}

export function buildWorkflowOpenAuthoringSessionToolDef(): JsonTool {
  return toolWithParameters(
    "WorkflowOpenAuthoringSession",
    "Open the current workspace ResourcePackage by default, create one from an explicit complete text file set, or explicitly open a recoverable legacy workflow authoring session.",
    {
      type: "object",
      oneOf: [
        {
          type: "object",
          properties: {
            session_id: { type: "string" },
            selected_resource_refs: { type: "array", items: { type: "string" }, minItems: 1 },
          },
          required: [],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            artifact_kind: { type: "string", enum: ["resource-package"] },
            source_kind: { type: "string", enum: ["workspace-layer"] },
            session_id: { type: "string" },
            selected_resource_refs: { type: "array", items: { type: "string" }, minItems: 1 },
          },
          required: ["artifact_kind", "source_kind"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            artifact_kind: { type: "string", enum: ["resource-package"] },
            source_kind: { type: "string", enum: ["explicit-complete-package"] },
            session_id: { type: "string" },
            files: {
              type: "array",
              minItems: 1,
              maxItems: 128,
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  content: { type: "string" },
                },
                required: ["path", "content"],
                additionalProperties: false,
              },
            },
            selected_resource_refs: { type: "array", items: { type: "string" }, minItems: 1 },
          },
          required: ["artifact_kind", "source_kind", "files"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            artifact_kind: { type: "string", enum: ["legacy-vfs-workflow-bundle"] },
            session_id: { type: "string" },
            form: { type: "string", enum: ["AICtrlWorkflow", "AIDataWorkflow", "ai-ctrl", "ai-data"] },
            template_id: { type: "string" },
            prebuilt_id: { type: "string" },
            workflow_ref: { type: "string", description: "Published logical resource or VFS ref to import into /base and /work." },
            target: { type: "object", additionalProperties: true },
          },
          anyOf: [
            { type: "object", required: ["form"] },
            { type: "object", required: ["template_id"] },
            { type: "object", required: ["prebuilt_id"] },
            { type: "object", required: ["workflow_ref"] },
          ],
          additionalProperties: false,
        },
      ],
    },
    async (runtime, input) => {
      const component = createWorkflowComponentForRuntime(runtime)
      if (input.artifact_kind === "resource-package" && input.source_kind === "explicit-complete-package") {
        if (input.selected_resource_refs !== undefined && !Array.isArray(input.selected_resource_refs)) {
          throw new Error("ResourcePackage authoring selected_resource_refs must be an array")
        }
        const session = await component.sessions.openResourcePackage({
          sessionId: input.session_id,
          source: {
            kind: "explicit-complete-package",
            files: explicitCompletePackageFiles(input.files),
          },
          selectedResourceRefs: input.selected_resource_refs,
        })
        const opened = {
          ...session,
          selection: await component.sessions.readResourcePackageSelection(session.sessionId),
        }
        return withWorkflowDomainProgress(opened, {
          owner: "workflow.authoring",
          transition: "workspace_opened",
          subjectId: session.sessionId,
          revision: session.workingRevision,
        })
      }
      const opensWorkspaceResourcePackage = input.artifact_kind === "resource-package"
        || (input.artifact_kind === undefined
          && input.form === undefined
          && input.template_id === undefined
          && input.prebuilt_id === undefined
          && input.workflow_ref === undefined
          && input.target === undefined)
      if (opensWorkspaceResourcePackage) {
        if (input.template_id || input.prebuilt_id || input.workflow_ref || input.form || input.target) {
          throw new Error("ResourcePackage authoring does not accept legacy workflow starting facts")
        }
        if (input.source_kind !== undefined && input.source_kind !== "workspace-layer") {
          throw new Error("ResourcePackage authoring source_kind must be workspace-layer")
        }
        if (input.selected_resource_refs !== undefined && !Array.isArray(input.selected_resource_refs)) {
          throw new Error("ResourcePackage authoring selected_resource_refs must be an array")
        }
        const session = await component.sessions.openResourcePackage({
          sessionId: input.session_id,
          source: { kind: "workspace-layer" },
          selectedResourceRefs: input.selected_resource_refs,
        })
        const opened = {
          ...session,
          selection: await component.sessions.readResourcePackageSelection(session.sessionId),
        }
        return withWorkflowDomainProgress(opened, {
          owner: "workflow.authoring",
          transition: "workspace_opened",
          subjectId: session.sessionId,
          revision: session.workingRevision,
        })
      }
      const startingFacts = [input.template_id, input.prebuilt_id, input.workflow_ref].filter(Boolean)
      if (startingFacts.length > 1) throw new Error("Choose template_id, prebuilt_id or workflow_ref, not more than one")
      if (input.template_id) {
        const template = component.catalog.getTemplate(text(input.template_id, "template_id"))
        const session = await component.sessions.open({
          sessionId: input.session_id,
          form: template.form,
          template: template.files,
          target: input.target,
        })
        return withWorkflowDomainProgress(session, {
          owner: "workflow.authoring",
          transition: "workspace_opened",
          subjectId: session.sessionId,
          revision: session.workingRevision,
        })
      }
      if (input.prebuilt_id) {
        const prebuilt = component.catalog.getPrebuiltWorkflow(text(input.prebuilt_id, "prebuilt_id"))
        const session = await component.sessions.open({
          sessionId: input.session_id,
          form: prebuilt.form,
          template: prebuilt.files,
          target: input.target,
        })
        return withWorkflowDomainProgress(session, {
          owner: "workflow.authoring",
          transition: "workspace_opened",
          subjectId: session.sessionId,
          revision: session.workingRevision,
        })
      }
      if (input.workflow_ref) {
        if (!component.repository) throw new Error("Workflow definition repository is not bound")
        const captured = await component.repository.capture(text(input.workflow_ref, "workflow_ref"))
        const source = Object.entries(captured.files).map(([filePath, content]) => ({
          path: filePath,
          content,
        }))
        const session = await component.sessions.open({
          sessionId: input.session_id,
          form: captured.form,
          source,
          target: input.target ?? {
            scope: "definition",
            id: captured.fqn,
            path: captured.sourceBundlePath,
            resourceRef: captured.workflowRef,
          },
        })
        return withWorkflowDomainProgress(session, {
          owner: "workflow.authoring",
          transition: "workspace_opened",
          subjectId: session.sessionId,
          revision: session.workingRevision,
        })
      }
      const session = await component.sessions.open({
        sessionId: input.session_id,
        form: form(input.form),
        target: input.target,
      })
      return withWorkflowDomainProgress(session, {
        owner: "workflow.authoring",
        transition: "workspace_opened",
        subjectId: session.sessionId,
        revision: session.workingRevision,
      })
    },
  )
}

export function buildWorkflowCreateResourcePackageSessionToolDef(): JsonTool {
  return toolWithParameters(
    "WorkflowCreateResourcePackageSession",
    "Create one recoverable ResourcePackage authoring session from a complete model-authored UTF-8 file set. This does not publish or run the package.",
    {
      type: "object",
      properties: {
        session_id: { type: "string" },
        files: {
          type: "array",
          minItems: 1,
          maxItems: 128,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
        selected_resource_refs: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["files"],
      additionalProperties: false,
    },
    async (runtime, input) => {
      const component = createWorkflowComponentForRuntime(runtime)
      if (input.selected_resource_refs !== undefined && !Array.isArray(input.selected_resource_refs)) {
        throw new Error("ResourcePackage authoring selected_resource_refs must be an array")
      }
      const files = explicitCompletePackageFiles(input.files)
      let session: Awaited<ReturnType<typeof component.sessions.openResourcePackage>>
      try {
        session = await component.sessions.openResourcePackage({
          sessionId: input.session_id,
          source: { kind: "explicit-complete-package", files },
          selectedResourceRefs: input.selected_resource_refs,
          includeSelection: true,
        })
      } catch (error) {
        const diagnostics = boundedResourceDiagnostics(error)
        if (!diagnostics) throw error
        return withWorkflowDomainProgress({
          status: "validation_failed",
          diagnostics,
          diagnosticCount: diagnostics.length,
          truncated: ((error as { diagnostics?: readonly unknown[] }).diagnostics?.length ?? 0) > diagnostics.length,
          effectDispatched: false,
        }, {
          owner: "workflow.authoring",
          transition: "candidate_diagnostic",
          subjectId: typeof input.session_id === "string" && input.session_id.trim()
            ? input.session_id.trim()
            : "fresh-resource-package-candidate",
          revision: hashWorkflowBinaryFiles(files),
        })
      }
      const opened = {
        ...session,
        selection: session.selection,
      }
      return withWorkflowDomainProgress(opened, {
        owner: "workflow.authoring",
        transition: "workspace_opened",
        subjectId: session.sessionId,
        revision: session.workingRevision,
      })
    },
  )
}

export function buildWorkflowValidateAuthoringSessionToolDef(): JsonTool {
  return tool(
    "WorkflowValidateAuthoringSession",
    "Canonically validate the current /work package and bind proof to its content revision.",
    { session_id: { type: "string" } },
    ["session_id"],
    async (runtime, input) => {
      const component = createWorkflowComponentForRuntime(runtime)
      const sessionId = text(input.session_id, "session_id")
      const session = await component.sessions.describe(sessionId)
      if (session.artifactKind !== "resource-package") return component.sessions.validate(sessionId)
      const result = await component.sessions.prepareResourcePackagePublication({ sessionId })
      return withWorkflowDomainProgress(result, {
        owner: "workflow.authoring",
        transition: "proof_prepared",
        subjectId: sessionId,
        revision: result.revision,
      })
    },
  )
}

export function buildWorkflowDryRunAuthoringSessionToolDef(): JsonTool {
  return tool(
    "WorkflowDryRunAuthoringSession",
    "Statically dry-run the currently validated /work revision without dispatching effects.",
    { session_id: { type: "string" } },
    ["session_id"],
    (runtime, input) => createWorkflowComponentForRuntime(runtime).sessions.dryRun(text(input.session_id, "session_id")),
  )
}

export function buildWorkflowPublishAuthoringSessionToolDef(): JsonTool {
  return tool(
    "WorkflowPublishAuthoringSession",
    "Publish one current validated and dry-run authoring revision after explicit authorization; publication never executes it.",
    {
      session_id: { type: "string" },
      confirmed: { type: "boolean" },
      target_path: {
        type: "string",
        description: "Plain workspace-relative bundle directory, for example ai-trend-report; never a URI or manifest filename.",
      },
      expected_revision: {
        type: "string",
        description: "Required exact working revision for ResourcePackage publication.",
      },
    },
    ["session_id", "confirmed"],
    async (runtime, input) => {
      const component = createWorkflowComponentForRuntime(runtime)
      const sessionId = text(input.session_id, "session_id")
      const session = await component.sessions.describe(sessionId)
      if (session.artifactKind === "resource-package") {
        if (!component.resourcePackagePublisher) {
          throw new Error("Workflow ResourcePackage publisher is not bound to a workspace layer")
        }
        const result = await component.resourcePackagePublisher.publish({
          sessionId,
          expectedRevision: text(input.expected_revision, "expected_revision"),
          confirmed: input.confirmed === true,
        })
        const receipt = result.receipt
        if (!receipt || receipt.kind !== "workflow.resourcePackagePublicationReceipt") return result
        const appRef = session.target.selectedResourceRefs.find((ref) => receipt.appRefs.includes(ref))
          ?? (receipt.appRefs.length === 1 ? receipt.appRefs[0] : undefined)
        const workflowRef = session.target.selectedResourceRefs.find((ref) => receipt.entrypointWorkflowRefs.includes(ref))
          ?? (receipt.entrypointWorkflowRefs.length === 1 ? receipt.entrypointWorkflowRefs[0] : undefined)
        const outerId = outerSessionId(runtime)
        if (outerId && appRef && workflowRef) {
          const continuation = normalizeWorkflowFulfillmentContinuation({
            kind: "publication",
            authoring_session_id: sessionId,
            publication_receipt_id: receipt.receiptId,
            registry_revision: receipt.registryRevision,
            app_ref: appRef,
            workflow_ref: workflowRef,
          })!
          await component.sessions.writeFulfillmentContinuation(outerId, continuation)
          return withWorkflowDomainProgress({ ...result, continuation }, {
            owner: "workflow.publication",
            transition: "publication_created",
            subjectId: sessionId,
            revision: receipt.sourceRevision,
          })
        }
        return withWorkflowDomainProgress(result, {
          owner: "workflow.publication",
          transition: "publication_created",
          subjectId: sessionId,
          revision: receipt.sourceRevision,
        })
      }
      const result = await component.sessions.publish({
        sessionId,
        confirmed: input.confirmed === true,
        targetPath: input.target_path,
      })
      if (result.status !== "published" || typeof result.revision !== "string") return result
      return withWorkflowDomainProgress(result, {
        owner: "workflow.publication",
        transition: "publication_created",
        subjectId: sessionId,
        revision: result.revision,
      })
    },
  )
}

export function buildWorkflowPreparePublicationToolDef(): JsonTool {
  return tool(
    "WorkflowPreparePublication",
    "Deterministically produce the complete exact-revision diff, validation, static projection, build and component-derived acceptance-disposition receipt set without publishing or running real effects.",
    {},
    [],
    async (runtime, input) => {
      const component = createWorkflowComponentForRuntime(runtime)
      const { sessionId } = await activeAuthoringIdentity(runtime, input, component)
      const session = await component.sessions.describe(sessionId)
      const result = await (session.artifactKind === "resource-package"
        ? component.sessions.prepareResourcePackagePublication({ sessionId })
        : component.sessions.preparePublication({ sessionId }))
      return withWorkflowDomainProgress(result, {
        owner: "workflow.authoring",
        transition: "proof_prepared",
        subjectId: sessionId,
        revision: result.revision,
      })
    },
  )
}

export function buildWorkflowCompleteAuthoringToolDef(): JsonTool {
  return tool(
    "WorkflowCompleteAuthoring",
    "Request a terminal authoring transition; the component generates the authoritative typed receipt from persisted session and proof facts.",
    {
      stage: { type: "string", enum: ["coding", "testing", "releasing"] },
      outcome: { type: "string", enum: ["ready", "published", "waiting", "failed"] },
    },
    ["stage", "outcome"],
    async (runtime, input) => {
      const component = createWorkflowComponentForRuntime(runtime)
      const identity = await activeAuthoringIdentity(runtime, input, component)
      if (!identity.revision) throw new Error("active workflow authoring revision is not available")
      const receipt = await component.sessions.createAuthoringReceipt({
        sessionId: identity.sessionId,
        expectedWorkingRevision: identity.revision,
        stage: input.stage,
        outcome: input.outcome,
      })
      const outerId = outerSessionId(runtime)
      if (outerId && receipt.outcome === "ready") {
        const continuation = normalizeWorkflowFulfillmentContinuation({
          kind: "authoring",
          authoring_session_id: receipt.authoringSessionId,
          expected_revision: receipt.workingRevision,
          proof_receipt_ids: receipt.proofReceiptIds,
        })!
        await component.sessions.writeFulfillmentContinuation(outerId, continuation)
        return withWorkflowDomainProgress({ ...receipt, continuation }, {
          owner: "workflow.authoring",
          transition: "lifecycle_completed",
          subjectId: receipt.authoringSessionId,
          revision: receipt.workingRevision,
        })
      }
      return withWorkflowDomainProgress(receipt, {
        owner: "workflow.authoring",
        transition: "lifecycle_completed",
        subjectId: receipt.authoringSessionId,
        revision: receipt.workingRevision,
      })
    },
  )
}

export function buildWorkflowListAuthoringSessionsToolDef(): JsonTool {
  return tool(
    "WorkflowListAuthoringSessions",
    "List recoverable workflow authoring session facts for the current injected workspace root.",
    {
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      cursor: { type: "string" },
    },
    [],
    async (runtime, input) => projectWorkflowAuthoringSessionPage(
      await createWorkflowComponentForRuntime(runtime).sessions.list(),
      { limit: input.limit, cursor: input.cursor },
    ),
  )
}

export function buildWorkflowGetAuthoringSummaryToolDef(): JsonTool {
  return tool(
    "WorkflowGetAuthoringSummary",
    "Read one compact recoverable authoring session fact without guessing host paths.",
    { session_id: { type: "string" } },
    ["session_id"],
    async (runtime, input) => projectWorkflowAuthoringSummary(
      await createWorkflowComponentForRuntime(runtime).sessions.describe(text(input.session_id, "session_id")),
    ),
  )
}

export function buildWorkflowAuthoringToolDefs(): JsonTool[] {
  return [
    buildWorkflowGetAuthoringContextToolDef(),
    buildWorkflowListAuthoringTemplatesToolDef(),
    buildWorkflowListPrebuiltWorkflowsToolDef(),
    buildWorkflowListReusableAgentsToolDef(),
    buildWorkflowOpenAuthoringSessionToolDef(),
    buildWorkflowCreateResourcePackageSessionToolDef(),
    buildWorkflowValidateAuthoringSessionToolDef(),
    buildWorkflowDryRunAuthoringSessionToolDef(),
    buildWorkflowPreparePublicationToolDef(),
    buildWorkflowCompleteAuthoringToolDef(),
    buildWorkflowPublishAuthoringSessionToolDef(),
    buildWorkflowListAuthoringSessionsToolDef(),
    buildWorkflowGetAuthoringSummaryToolDef(),
  ]
}
