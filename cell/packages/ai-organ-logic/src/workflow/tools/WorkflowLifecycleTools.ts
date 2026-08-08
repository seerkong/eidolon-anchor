import type { AiAgentOneActorRuntime, ToolDef } from "@cell/ai-core-contract/types"
import { getWorkflowRuntimeService } from "../runtime"

type ToolConfig = Record<string, unknown>
type Input = Record<string, any>

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  run: (runtime: AiAgentOneActorRuntime<any, any>, input: Input) => Promise<unknown>,
): ToolDef<Input, string, ToolConfig> {
  return {
    schema: {
      type: "function",
      function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime, input) => {
      try {
        return JSON.stringify(await run(runtime, input ?? {}))
      } catch (error) {
        return JSON.stringify({ ok: false, error: String((error as Error)?.message ?? error) })
      }
    },
  }
}

export function buildWorkflowLifecycleToolDefs(): ToolDef<Input, string, ToolConfig>[] {
  return [
    tool("WorkflowListTypes", "List published workflow Types and their current content revisions.", {}, [], async (runtime) => ({
      ok: true, kind: "workflow.types", types: await getWorkflowRuntimeService(runtime).listTypes(),
    })),
    tool("WorkflowGetType", "Inspect one published workflow Type without executing it.", {
      workflow_ref: { type: "string" },
    }, ["workflow_ref"], async (runtime, input) => ({
      ok: true, kind: "workflow.type", type: await getWorkflowRuntimeService(runtime).getType(String(input.workflow_ref)),
    })),
    tool("WorkflowCreateInstance", "Create a durable workflow Instance with a frozen definition revision; this never executes it.", {
      workflow_ref: { type: "string" }, instance_id: { type: "string" }, input: {}, idempotency_key: { type: "string" },
    }, ["workflow_ref"], async (runtime, input) => ({
      ok: true,
      kind: "workflow.instance",
      instance: await getWorkflowRuntimeService(runtime).createInstance({
        workflowRef: String(input.workflow_ref),
        instanceId: input.instance_id ? String(input.instance_id) : undefined,
        initialInput: input.input,
        idempotencyKey: input.idempotency_key ? String(input.idempotency_key) : undefined,
      }),
      effectDispatched: false,
    })),
    tool("WorkflowCreateInstanceFromPrebuilt", "Create a durable workflow Instance from an installed prebuilt starting fact; this never executes it.", {
      prebuilt_id: { type: "string" }, instance_id: { type: "string" }, input: {}, idempotency_key: { type: "string" },
    }, ["prebuilt_id"], async (runtime, input) => ({
      ok: true,
      kind: "workflow.instance",
      instance: await getWorkflowRuntimeService(runtime).createInstanceFromPrebuilt({
        prebuiltId: String(input.prebuilt_id),
        instanceId: input.instance_id ? String(input.instance_id) : undefined,
        initialInput: input.input,
        idempotencyKey: input.idempotency_key ? String(input.idempotency_key) : undefined,
      }),
      effectDispatched: false,
    })),
    tool("WorkflowListInstances", "List durable workflow Instances.", {}, [], async (runtime) => ({
      ok: true, kind: "workflow.instances", instances: await getWorkflowRuntimeService(runtime).listInstances(),
    })),
    tool("WorkflowListSessionFlows", "List durable Instance and Run associations in the current Eidolon session.", {}, [], async (runtime) => ({
      ok: true, kind: "workflow.sessionFlows", instances: await getWorkflowRuntimeService(runtime).listInstances(),
    })),
    tool("WorkflowGetInstance", "Inspect one durable workflow Instance.", {
      instance_id: { type: "string" },
    }, ["instance_id"], async (runtime, input) => {
      const instance = await getWorkflowRuntimeService(runtime).getInstance(String(input.instance_id))
      return instance ? { ok: true, kind: "workflow.instance", instance } : { ok: false, error: "not_found" }
    }),
    tool("WorkflowUpdateRunVars", "Update Instance input facts before start; started Instances are immutable.", {
      instance_id: { type: "string" }, input: {},
    }, ["instance_id", "input"], async (runtime, input) => ({
      ok: true,
      kind: "workflow.instance",
      instance: await getWorkflowRuntimeService(runtime).updateInstanceInput(String(input.instance_id), input.input),
      effectDispatched: false,
    })),
    tool("WorkflowGetFlowSummary", "Read one Run summary with descriptor, Instance and frozen Material receipt facts.", {
      run_id: { type: "string" },
    }, ["run_id"], async (runtime, input) => {
      const summary = await getWorkflowRuntimeService(runtime).flowSummary(String(input.run_id))
      return summary ?? { ok: false, error: "not_found", run_id: String(input.run_id) }
    }),
    tool("WorkflowMaterialImport", "Import a workspace-contained file or directory as an immutable Material revision.", {
      material_ref: { type: "string" }, source_path: { type: "string" }, provenance: { type: "object" }, confirmed: { type: "boolean" },
    }, ["material_ref", "source_path"], async (runtime, input) => {
      const material = await getWorkflowRuntimeService(runtime).materials.import({
        materialRef: String(input.material_ref), sourcePath: String(input.source_path), provenance: input.provenance,
        confirmed: input.confirmed === true,
      })
      return "status" in material
        ? material
        : { ok: true, kind: "workflow.materialRevision", material }
    }),
    tool("WorkflowMaterialInspect", "Inspect one exact immutable Material revision.", {
      material_ref: { type: "string" }, revision: { type: "string" },
    }, ["material_ref", "revision"], async (runtime, input) => ({
      ok: true,
      kind: "workflow.materialRevision",
      material: await getWorkflowRuntimeService(runtime).materials.inspect({
        materialRef: String(input.material_ref), revision: String(input.revision),
      }),
    })),
    tool("WorkflowMaterialBind", "Bind an exact Material revision to one prepared Instance node port.", {
      instance_id: { type: "string" }, node_id: { type: "string" }, port: { type: "string" },
      material_ref: { type: "string" }, revision: { type: "string" },
    }, ["instance_id", "node_id", "port", "material_ref", "revision"], async (runtime, input) => ({
      ok: true,
      kind: "workflow.materialBinding",
      binding: await getWorkflowRuntimeService(runtime).bindMaterial({
        instanceId: String(input.instance_id), nodeId: String(input.node_id), port: String(input.port),
        material: { materialRef: String(input.material_ref), revision: String(input.revision) },
      }),
    })),
    tool("WorkflowMaterialExport", "Preview or explicitly confirm export of one exact Material revision.", {
      material_ref: { type: "string" }, revision: { type: "string" }, destination_path: { type: "string" }, confirmed: { type: "boolean" },
    }, ["material_ref", "revision", "destination_path"], async (runtime, input) => getWorkflowRuntimeService(runtime).materials.export({
      material: { materialRef: String(input.material_ref), revision: String(input.revision) },
      destinationPath: String(input.destination_path), confirmed: input.confirmed === true,
    })),
    tool("WorkflowMaterialReplay", "Replay a Run from its frozen receipt and exact Material revisions; execution requires confirmation.", {
      run_id: { type: "string" }, new_run_id: { type: "string" }, confirmed: { type: "boolean" },
    }, ["run_id"], async (runtime, input) => getWorkflowRuntimeService(runtime).replay({
      runId: String(input.run_id), newRunId: input.new_run_id ? String(input.new_run_id) : undefined, confirmed: input.confirmed === true,
    })),
    tool("WorkflowMaterialCleanup", "Preview or explicitly confirm cleanup of unleased Material revisions.", {
      material_ref: { type: "string" }, confirmed: { type: "boolean" },
    }, [], async (runtime, input) => getWorkflowRuntimeService(runtime).materials.cleanup({
      materialRef: input.material_ref ? String(input.material_ref) : undefined, confirmed: input.confirmed === true,
    })),
  ]
}
