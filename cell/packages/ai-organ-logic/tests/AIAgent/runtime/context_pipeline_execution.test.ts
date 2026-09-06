import { describe, expect, it } from "bun:test";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM, ensureVmRuntimeContext } from "@cell/ai-core-logic/runtime/runtime";
import { serializeActor, hydrateActor } from "@cell/ai-core-logic/runtime/snapshot/actorSnapshot";
import { createActorDurableMaterial } from "@cell/ai-core-logic/runtime/ActorDurableMaterial";
import { digestAgentContextPipelineBinding } from "@cell/ai-core-logic/runtime/AgentContextPipeline";
import { buildProviderPromptForActorTurn, seedConversationDomainFromActorSeedMessages } from "@cell/ai-organ-logic/exec/AiAgentExecutor";
import { createConversationDomainRuntime } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime";
import type { AgentContextPipelineBinding, AgentContextPipelineRuntime } from "@cell/ai-core-contract/runtime/AgentContextPipeline";
import { BUILTIN_SCENARIOS, compareProviderMessageSequences, runScriptedAssemblyScenario } from "../conversation/providerEquivalenceHarness";
import { composeLayeredResourceRegistry, loadResourceTreeFromReadPort } from "halfcode-compiler.xnl/resource-core";
import { depaAIResourceKindContract } from "ai-workflow-contract";
import { projectAIWorkflowAgentResources } from "ai-workflow-logic";
import { restoreAIAgentCodeExecution } from "ai-workflow-logic/agent-code-execution";
import { compileEidolonAgentCodeResource, createAgentCodeMemoryReadPort, EIDOLON_AGENT_CODE_ENVIRONMENT } from "../../../src/resources/EidolonAgentCodeExecution";
import standardContextSource from "../../../src/resources/compat/standard-context.ts.txt" with { type: "text" };

const material = createActorDurableMaterial("frozen execution fixture");
const binding: AgentContextPipelineBinding = {
  schemaVersion: "eidolon.agent-context-pipeline-binding/v2",
  resourceId: "fixture.Context",
  contentDigest: `sha256:${"1".repeat(64)}`,
  executionDigest: `sha256:${"2".repeat(64)}`,
  materialDigest: material.digest,
};

function fixture(execute?: (runtime: AgentContextPipelineRuntime, input: any) => unknown) {
  const actor = createActor({
    key: "main", systemPrompts: ["stable prefix"],
    contextPipeline: binding,
    durableMaterials: { [material.digest]: material },
    ...(execute ? { contextPipelineExecution: {
      bindingDigest: digestAgentContextPipelineBinding(binding),
      executionDigest: binding.executionDigest,
      execute,
    } } : {}),
  });
  const conversationDomainRuntime = createConversationDomainRuntime();
  const vm = createVM({
    controlActorKey: "main", actors: { main: actor },
    options: { storage: { logs: false, files: false } },
    outerCtx: { metadata: { sessionId: "pipeline-test" } },
  });
  ensureVmRuntimeContext(vm).conversationDomainRuntime = conversationDomainRuntime;
  seedConversationDomainFromActorSeedMessages({ vm, actor, seedMessages: [{ role: "user", content: "hello" }] });
  return { actor, vm, conversationDomainRuntime };
}

function standard(runtime: AgentContextPipelineRuntime, input: any) {
  const plan = runtime.plan();
  const materialization = runtime.materialize(plan);
  return runtime.convert(input.mode === "estimate" ? runtime.completeEstimate(materialization) : materialization);
}

function build(f: ReturnType<typeof fixture>, recordPromptPlan = true) {
  return buildProviderPromptForActorTurn({ ...f, llmAdapter: { type: "openai" } as any, model: "test", tools: [], recordPromptPlan });
}

describe("executable context pipeline", () => {
  it("executes and restores the actual compiled context source through all mature scenarios", async () => {
    const source = createAgentCodeMemoryReadPort({
      "manifest.xnl": `<ResourcePackage #fixture.package envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle="Active" packageVersion="1.0.0" } (
        <Catalogs [
          <Catalog #kinds { kind="KindDefinition" shape="directory" root="vfs://./KindDefinitions/" entry="manifest.xnl" }>
          <Catalog #context { kind="AgentContextPipeline" shape="single-file" root="vfs://./ContextPipelines/" }>
        ]>
      )>`,
      "KindDefinitions/AgentContextPipeline/manifest.xnl": depaAIResourceKindContract("AgentContextPipeline", 2).kindDefinitionSource,
      "ContextPipelines/Context.xnl": `<AgentContextPipeline #fixture.Context envelopeVersion="halfcode.resource-envelope/v1" specVersion=2 { lifecycle="Active" } (
        <CodeBinding { packageName="fixture-code" module="./context.ts" exportName="buildContext" }>
      )>`,
      "context.ts": standardContextSource,
    });
    const tree = await loadResourceTreeFromReadPort({ port: source });
    const projection = projectAIWorkflowAgentResources(composeLayeredResourceRegistry({ layers: [{ id: "workspace", tree }] }));
    const code = projection.codeResources!.find((entry) => entry.resource.resourceId === "fixture.Context")!;
    const compiled = await compileEidolonAgentCodeResource({ source, sourceRoot: "/" }, code);
    // Restore only artifact bytes and an authentic resource projection; the read port is absent.
    const restored = restoreAIAgentCodeExecution({ environment: EIDOLON_AGENT_CODE_ENVIRONMENT }, code,
      JSON.parse(JSON.stringify(compiled.artifact)), compiled.artifactDigest);
    const closedMaterial = createActorDurableMaterial(JSON.stringify(compiled.artifact));
    const closedBinding = { ...binding, contentDigest: compiled.artifact.resourceDigest, executionDigest: compiled.artifactDigest, materialDigest: closedMaterial.digest };
    const contextExecution = {
      contextPipeline: closedBinding,
      durableMaterials: { [closedMaterial.digest]: closedMaterial },
      contextPipelineExecution: {
        bindingDigest: digestAgentContextPipelineBinding(closedBinding),
        executionDigest: restored.artifactDigest,
        execute: restored.execute,
      },
    };
    for (const scenario of BUILTIN_SCENARIOS) {
      const baseline = await runScriptedAssemblyScenario(scenario);
      const executable = await runScriptedAssemblyScenario(scenario, contextExecution);
      for (let index = 0; index < baseline.snapshots.length; index++) {
        expect(compareProviderMessageSequences(executable.snapshots[index]!.productionProviderMessages,
          baseline.snapshots[index]!.productionProviderMessages)).toEqual([]);
      }
    }
  });

  it("preserves every mature scripted prompt boundary through the executable runtime", async () => {
    const f = fixture(standard);
    for (const scenario of BUILTIN_SCENARIOS) {
      const baseline = await runScriptedAssemblyScenario(scenario);
      const executable = await runScriptedAssemblyScenario(scenario, f.actor);
      expect(executable.snapshots.map((snapshot) => snapshot.label)).toEqual(baseline.snapshots.map((snapshot) => snapshot.label));
      for (let index = 0; index < baseline.snapshots.length; index++) {
        expect(compareProviderMessageSequences(
          executable.snapshots[index]!.productionProviderMessages,
          baseline.snapshots[index]!.productionProviderMessages,
        )).toEqual([]);
      }
    }
  });

  it("executes immutable stage input and preserves estimate zero-effects / exactly one record", () => {
    const calls: string[] = [];
    const f = fixture((runtime, input) => {
      expect(Object.isFrozen(runtime)).toBe(true);
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.keys(runtime).sort()).toEqual(["completeEstimate", "convert", "materialize", "plan"]);
      calls.push(input.mode);
      return standard(runtime, input);
    });
    const before = structuredClone(f.conversationDomainRuntime.promptStateSignal.get());
    const estimate = build(f, false);
    build(f, false);
    expect(f.conversationDomainRuntime.promptStateSignal.get()).toEqual(before);
    const recorded = build(f);
    expect(calls).toEqual(["estimate", "estimate", "record"]);
    expect(recorded.providerMessages).toEqual(estimate.providerMessages);
    expect(recorded.promptGenerationId).toBeTruthy();
    expect(f.conversationDomainRuntime.promptStateSignal.get()["pipeline-test::main"].generations).toHaveLength(1);
    expect(JSON.stringify(recorded.providerMessages)).not.toContain("work-context");
  });

  it("rejects missing or mismatched runtime handles and forged output", () => {
    expect(() => build(fixture())).toThrow("AGENT_CONTEXT_PIPELINE_EXECUTION_UNAVAILABLE");
    const mismatched = fixture(standard);
    mismatched.actor.contextPipelineExecution = { ...mismatched.actor.contextPipelineExecution!, executionDigest: "wrong" };
    expect(() => build(mismatched)).toThrow("AGENT_CONTEXT_PIPELINE_EXECUTION_MISMATCH");
    expect(() => build(fixture(() => ({ providerMessages: [{ role: "system", content: "injected" }] })))).toThrow("AGENT_CONTEXT_PIPELINE_RESULT_INVALID");
  });

  it("rejects repeated plan recording and skipped estimation completion", () => {
    const repeated = fixture((runtime) => { runtime.plan(); return runtime.plan(); });
    expect(() => build(repeated)).toThrow("AGENT_CONTEXT_PIPELINE_STAGE_INVALID");
    expect(repeated.conversationDomainRuntime.promptStateSignal.get()["pipeline-test::main"].generations).toHaveLength(1);
    const skipped = fixture((runtime) => runtime.convert(runtime.materialize(runtime.plan())));
    expect(() => build(skipped, false)).toThrow("AGENT_CONTEXT_PIPELINE_STAGE_INVALID");
  });

  it("serializes v2 binding and durable material but strips process-local code", () => {
    const f = fixture(standard);
    const snapshot = serializeActor(f.actor);
    expect(snapshot.contextPipeline).toEqual(binding);
    expect("contextPipelineExecution" in snapshot).toBe(false);
    const restored = hydrateActor(JSON.parse(JSON.stringify(snapshot)));
    expect(restored.contextPipeline).toEqual(binding);
    expect(restored.durableMaterials).toEqual(f.actor.durableMaterials);
    expect(restored.contextPipelineExecution).toBeUndefined();
  });

  it("closes escaped runtime ports after resource return or rejection", () => {
    let escaped: AgentContextPipelineRuntime | undefined;
    const f = fixture((runtime, input) => { escaped = runtime; return standard(runtime, input); });
    build(f);
    expect(() => escaped!.plan()).toThrow("AGENT_CONTEXT_PIPELINE_STAGE_INVALID");
    const rejected = fixture((runtime) => { escaped = runtime; return undefined; });
    expect(() => build(rejected)).toThrow("AGENT_CONTEXT_PIPELINE_RESULT_INVALID");
    expect(() => escaped!.plan()).toThrow("AGENT_CONTEXT_PIPELINE_STAGE_INVALID");
  });
});
