import { describe, expect, it } from "bun:test";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM, ensureVmRuntimeContext } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { createActorDurableMaterial } from "@cell/ai-core-logic/runtime/ActorDurableMaterial";
import { digestAgentContextPipelineBinding } from "@cell/ai-core-logic/runtime/AgentContextPipeline";
import { normalizeAgentContextFactPresentationRecipe } from "@cell/ai-core-logic/runtime/AgentContextFactPresentation";
import { aiAgentLoopStreaming, buildProviderPromptForActorTurn, ensureActorProviderContextEpochBeforeTransport, seedConversationDomainFromActorSeedMessages } from "../../../src/exec/AiAgentExecutor";
import {
  appendActorProviderContextFactToConversationDomainRuntime,
  appendLiveHistoryMessageToConversationDomainRuntime,
  createConversationDomainRuntime,
  getConversationActorRawStateFromVm,
  getConversationSessionRawStateFromVm,
} from "../../../src/conversation/ConversationDomainRuntime";
import { materializeConversationRuntimePrompt } from "@cell/ai-persistence-logic/ConversationProjection";
import { createMockProcessStream, createMockProviderCacheCostObservation } from "../__test_support__/mockProcessStream";
import { createResponsesProviderOutputSnapshot } from "../../../src/llm";
import type { ResponsesTransportRequestContext } from "@cell/ai-organ-contract";
import { composeLayeredResourceRegistry, loadResourceTreeFromReadPort } from "halfcode-compiler.xnl/resource-core";
import { depaAIResourceKindContract } from "ai-workflow-contract";
import { projectAIWorkflowAgentResources } from "ai-workflow-logic";
import { compileEidolonAgentCodeResource, createAgentCodeMemoryReadPort, prepareEidolonContextFactPresentation } from "../../../src/resources/EidolonAgentCodeExecution";

const recipe = {
  schemaVersion: "eidolon.context-fact-presentation/v1",
  rules: [{ namespace: "workflow-stage-context", payloadKeys: ["stage", "context"], jsonLayout: "pretty" }],
};

function setup() {
  const material = createActorDurableMaterial("presentation-test");
  const contextPipeline = {
    schemaVersion: "eidolon.agent-context-pipeline-binding/v2" as const,
    resourceId: "test.Context", contentDigest: `sha256:${"a".repeat(64)}`,
    executionDigest: `sha256:${"b".repeat(64)}`, materialDigest: material.digest,
  };
  const actor = createActor({
    key: "main", systemPrompts: ["stable prefix"], contextPipeline,
    durableMaterials: { [material.digest]: material },
    contextPipelineExecution: {
      bindingDigest: digestAgentContextPipelineBinding(contextPipeline), executionDigest: contextPipeline.executionDigest,
      factPresentation: normalizeAgentContextFactPresentationRecipe(recipe),
      execute(runtime, input) {
        const messages = runtime.materialize(runtime.plan());
        return runtime.convert(input.mode === "estimate" ? runtime.completeEstimate(messages) : messages);
      },
    },
  });
  const conversation = createConversationDomainRuntime();
  const vm = createVM({ controlActorKey: actor.key, actors: { main: actor },
    registries: { toolRegistry: new ToolFuncRegistry() },
    options: { storage: { logs: false, files: false } }, outerCtx: { metadata: { sessionId: "fact-presentation" } } });
  ensureVmRuntimeContext(vm).conversationDomainRuntime = conversation;
  seedConversationDomainFromActorSeedMessages({ vm, actor, seedMessages: [{ role: "user", content: "first user" }] });
  function append(namespace: "workflow-stage-context" | "provider-output-recovery" | "work-context", payload: Record<string, unknown>) {
    return appendActorProviderContextFactToConversationDomainRuntime({ runtime: conversation, sessionId: "fact-presentation",
      actorKey: actor.key, actorId: actor.id, namespace, payload, occurredAt: "2026-09-06T00:00:00.000Z" });
  }
  function build(record = false) {
    return buildProviderPromptForActorTurn({ vm, actor, tools: [], model: "test", llmAdapter: { type: "openai" } as any, recordPromptPlan: record });
  }
  return { actor, vm, conversation, append, build };
}

describe("frozen context fact presentation", () => {
  it("executes native helper revisions that select different admitted fields in actual provider requests", async () => {
    async function prepare(payloadKeys: string[]) {
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
          <Config { value={ factPresentationProtocol="eidolon.context-fact-presentation/v1" } }>
        )>`,
        "context.ts": `import { payloadKeys } from "./helper.ts";
          export function buildContext(runtime, input, config) {
            if (input.kind === "describe-fact-presentation") return {
              schemaVersion: config.factPresentationProtocol,
              rules: [{ namespace: "workflow-stage-context", payloadKeys, jsonLayout: "canonical" }],
            };
            const messages = runtime.materialize(runtime.plan());
            return runtime.convert(input.mode === "estimate" ? runtime.completeEstimate(messages) : messages);
          }`,
        "helper.ts": `export const payloadKeys = ${JSON.stringify(payloadKeys)};`,
      });
      const tree = await loadResourceTreeFromReadPort({ port: source });
      const projection = projectAIWorkflowAgentResources(composeLayeredResourceRegistry({ layers: [{ id: "workspace", tree }] }));
      const code = projection.codeResources!.find((entry) => entry.resource.resourceId === "fixture.Context")!;
      const compiled = await compileEidolonAgentCodeResource({ source, sourceRoot: "/" }, code);
      const factPresentation = prepareEidolonContextFactPresentation(compiled)!;
      expect(factPresentation).toBeDefined();
      const material = createActorDurableMaterial(JSON.stringify({ artifact: compiled.artifact, factPresentation }));
      const binding = {
        schemaVersion: "eidolon.agent-context-pipeline-binding/v2" as const,
        resourceId: compiled.artifact.resourceId, contentDigest: compiled.artifact.resourceDigest,
        executionDigest: compiled.artifactDigest, materialDigest: material.digest,
      };
      const f = setup();
      f.actor.contextPipeline = Object.freeze(binding);
      f.actor.durableMaterials = Object.freeze({ [material.digest]: material });
      f.actor.contextPipelineExecution = Object.freeze({
        bindingDigest: digestAgentContextPipelineBinding(binding), executionDigest: compiled.artifactDigest,
        factPresentation, execute: compiled.execute,
      });
      const requests: any[][] = [];
      f.actor.llmClient = { type: "openai", async createStream(options: any) {
        requests.push(structuredClone(options.messages));
        return { stream: (async function* () { yield { ok: true }; })(),
          providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) };
      } };
      f.actor.modelConfig = { model: "test" };
      f.actor.callbacks = { buildToolset: () => [], processStream: createMockProcessStream(() => ({ role: "assistant", content: "done" })) };
      await ensureActorProviderContextEpochBeforeTransport({ vm: f.vm, actor: f.actor });
      f.append("workflow-stage-context", { stage: "coding", context: "real stage instructions", allowedTools: ["read"], packageProvenanceDigest: "provenance" });
      return { ...f, compiled, requests };
    }
    const v1 = await prepare(["stage", "context", "allowedTools"]);
    const v2 = await prepare(["stage", "context", "allowedTools", "packageProvenanceDigest"]);
    expect(v1.compiled.artifact.resourceDigest).toBe(v2.compiled.artifact.resourceDigest);
    expect(v1.compiled.artifactDigest).not.toBe(v2.compiled.artifactDigest);
    await aiAgentLoopStreaming({ vm: v1.vm, actor: v1.actor, messages: [] });
    await aiAgentLoopStreaming({ vm: v2.vm, actor: v2.actor, messages: [] });
    const factMessage = (messages: any[]) => messages.find((message) => String(message.content).startsWith("eidolon-context-fact/v1\n"));
    const parse = (message: any) => JSON.parse(message.content.slice("eidolon-context-fact/v1\n".length));
    expect(parse(factMessage(v1.requests[0]!)).payload).toEqual({ stage: "coding", context: "real stage instructions", allowedTools: ["read"] });
    expect(parse(factMessage(v2.requests[0]!)).payload).toEqual({ stage: "coding", context: "real stage instructions", allowedTools: ["read"], packageProvenanceDigest: "provenance" });
    expect(v1.requests[0]!.filter((message) => message.role === "system")).toEqual(v2.requests[0]!.filter((message) => message.role === "system"));
    expect(factMessage(v1.build().providerMessages)).toEqual(factMessage(v1.requests[0]!));
  });

  it("normalizes detached frozen recipes and rejects protected namespaces and executable shapes", () => {
    const raw = structuredClone(recipe);
    const normalized = normalizeAgentContextFactPresentationRecipe(raw);
    raw.rules[0]!.payloadKeys.push("allowedTools");
    expect(normalized.rules[0]!.payloadKeys).toEqual(["context", "stage"]);
    expect(Object.isFrozen(normalized.rules[0]!.payloadKeys)).toBe(true);
    for (const namespace of ["work-context", "provider-output-recovery", "provider-recovery", "provider-projection", "other"]) {
      expect(() => normalizeAgentContextFactPresentationRecipe({ ...recipe, rules: [{ ...recipe.rules[0], namespace }] })).toThrow("AGENT_CONTEXT_FACT_PRESENTATION_INVALID");
    }
    for (const rule of [
      { ...recipe.rules[0], payloadKeys: [] },
      { ...recipe.rules[0], payloadKeys: ["stage", "stage"] },
      { ...recipe.rules[0], payloadKeys: [undefined] },
      { ...recipe.rules[0], jsonLayout: "markdown" },
      { ...recipe.rules[0], role: "system" },
    ]) expect(() => normalizeAgentContextFactPresentationRecipe({ ...recipe, rules: [rule] })).toThrow("AGENT_CONTEXT_FACT_PRESENTATION_INVALID");
    expect(() => normalizeAgentContextFactPresentationRecipe({ ...recipe, rules: [recipe.rules[0], recipe.rules[0]] })).toThrow("AGENT_CONTEXT_FACT_PRESENTATION_INVALID");
    let invoked = false;
    const accessor = Object.defineProperty({}, "rules", { enumerable: true, get() { invoked = true; return []; } });
    expect(() => normalizeAgentContextFactPresentationRecipe(accessor)).toThrow("AGENT_CONTEXT_FACT_PRESENTATION_INVALID");
    expect(invoked).toBe(false);
  });

  it("keeps old anchored bytes and stable prefix when later facts/history/control state change", () => {
    const f = setup();
    const admitted = f.append("workflow-stage-context", { stage: "coding", context: "frozen context", allowedTools: ["read"], packageDigest: "provenance" });
    const first = f.build();
    const rendered = first.providerMessages.find((message) => String(message.content).startsWith("eidolon-context-fact/v1\n"));
    expect(rendered).toEqual({ role: "user", content: 'eidolon-context-fact/v1\n{\n  "namespace": "workflow-stage-context",\n  "payload": {\n    "context": "frozen context",\n    "stage": "coding"\n  },\n  "revision": 1\n}' });
    expect(admitted.payload.allowedTools).toEqual(["read"]);
    appendLiveHistoryMessageToConversationDomainRuntime({ vm: f.vm, actorKey: f.actor.key, actorId: f.actor.id, message: { role: "user", content: "later user" } });
    f.append("workflow-stage-context", { stage: "verify", context: "second context", allowedTools: ["test"] });
    f.actor.workContext.taskPhase = "answer";
    const before = structuredClone(getConversationActorRawStateFromVm({ vm: f.vm, actorKey: f.actor.key }));
    const later = f.build();
    f.build();
    expect(getConversationActorRawStateFromVm({ vm: f.vm, actorKey: f.actor.key })).toEqual(before);
    expect(later.providerMessages.slice(0, first.providerMessages.length)).toEqual(first.providerMessages);
    expect(later.providerMessages.filter((message) => message.role === "system")).toEqual(first.providerMessages.filter((message) => message.role === "system"));
    const recorded = f.build(true);
    expect(recorded.providerMessages).toEqual(later.providerMessages);
    expect(f.conversation.promptStateSignal.get()["fact-presentation::main"].generations).toHaveLength(1);
  });

  it("keeps recovery instructions exact and never exposes restored WorkContext", () => {
    const f = setup();
    f.append("work-context", { taskPhase: "answer" });
    const recovery = f.append("provider-output-recovery", { instruction: "Retry the exact action", operationId: "op-1", requestOrdinal: 2 });
    const raw = getConversationActorRawStateFromVm({ vm: f.vm, actorKey: f.actor.key })!;
    const standard = materializeConversationRuntimePrompt(raw);
    const projected = materializeConversationRuntimePrompt(raw, f.actor.contextPipelineExecution!.factPresentation);
    expect(projected).toEqual(standard);
    expect(JSON.stringify(projected)).not.toContain("work-context");
    expect(JSON.stringify(projected)).toContain(recovery.payload.instruction);
  });

  it("validates immutable fact anchors and chain before selecting any payload fields", () => {
    const f = setup();
    f.append("workflow-stage-context", { stage: "coding", unselected: "opaque" });
    const raw = getConversationActorRawStateFromVm({ vm: f.vm, actorKey: f.actor.key })!;
    for (const change of [
      (fact: any) => { fact.anchor.frontierDigest = `sha256:${"0".repeat(64)}`; },
      (fact: any) => { fact.anchor.historyGenerationId = "missing"; },
      (fact: any) => { fact.anchor.messageCount = 999; },
      (fact: any) => { fact.sequence = 9; },
    ]) {
      const broken = structuredClone(raw);
      const fact = broken.session.contextAssets!.find((asset) => asset.providerContextFact)!.providerContextFact!;
      change(fact);
      expect(() => materializeConversationRuntimePrompt(broken, f.actor.contextPipelineExecution!.factPresentation)).toThrow();
    }
  });

  it("preserves presented fact bytes on the real empty-output retry request", async () => {
    const f = setup();
    const requests: any[][] = [];
    f.actor.llmClient = {
      type: "openai",
      async createStream(options: any) {
        requests.push(structuredClone(options.messages));
        return { stream: (async function* () { yield { ok: true }; })(),
          providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) };
      },
    };
    f.actor.modelConfig = { model: "test" };
    let processed = 0;
    f.actor.callbacks = {
      buildToolset: () => [],
      processStream: createMockProcessStream(() => ({ role: "assistant", content: ++processed === 1 ? "" : "recovered" })),
    };
    await ensureActorProviderContextEpochBeforeTransport({ vm: f.vm, actor: f.actor });
    f.append("workflow-stage-context", { stage: "coding", context: "selected", privateProvenance: "omitted" });
    const result = await aiAgentLoopStreaming({ vm: f.vm, actor: f.actor, messages: [] });
    expect(result.stopReason).toBe("no_tool_calls");
    expect(requests).toHaveLength(2);
    const stageFact = (messages: any[]) => messages.find((message) => String(message.content).includes('"namespace": "workflow-stage-context"'));
    expect(stageFact(requests[0]!)).toBeDefined();
    expect(stageFact(requests[1]!)).toEqual(stageFact(requests[0]!));
    expect(JSON.stringify(requests)).not.toContain("privateProvenance");
    expect(JSON.stringify(requests[1])).toContain("previous assistant response was empty");
    const generations = f.conversation.promptStateSignal.get()["fact-presentation::main"].generations;
    expect(generations).toHaveLength(1);
  });

  it("commits a recipe-aware Responses frontier and keeps the next request incremental", async () => {
    const f = setup();
    const contexts: ResponsesTransportRequestContext[] = [];
    f.actor.llmClient = {
      type: "openai",
      runtime: { adapterName: "openai-responses", providerId: "openai" },
      options: { responses_continuation_mode: "stateful_chain", transport_mode: "websocket", supports_websockets: true },
      async createStream(options: any) {
        const context = options.providerRequestContext as ResponsesTransportRequestContext;
        contexts.push(context);
        const ordinal = contexts.length;
        return { stream: (async function* () { yield { ok: true }; })(), providerOutput: Promise.resolve({
          provider_cache_cost_observation: createMockProviderCacheCostObservation(options),
          schemaVersion: 1, kind: "responses_transport_result", plan: context.primary,
          transport: "websocket", responseStored: true,
          outputDecision: { schemaVersion: 1, kind: "responses_native_output_completeness_decision", status: "complete",
            output: createResponsesProviderOutputSnapshot({ responseId: `fact-response-${ordinal}`, items: [{
              type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `answer-${ordinal}` }],
            }] }) },
        }) };
      },
    };
    f.actor.modelConfig = { model: "test" };
    let processed = 0;
    f.actor.callbacks = { buildToolset: () => [], processStream: createMockProcessStream(() => ({ role: "assistant", content: `answer-${++processed}` })) };
    await ensureActorProviderContextEpochBeforeTransport({ vm: f.vm, actor: f.actor });
    f.append("workflow-stage-context", { stage: "coding", context: "selected", privateProvenance: "omitted" });
    await aiAgentLoopStreaming({ vm: f.vm, actor: f.actor, messages: [] });
    expect(contexts[0]!.primary.kind).toBe("stateless_replay");
    expect(JSON.stringify(contexts[0]!.primary.input)).not.toContain("privateProvenance");
    expect(getConversationSessionRawStateFromVm({ vm: f.vm, sessionId: "fact-presentation" })?.contextAssets?.some((asset) => asset.replayCheckpoint)).toBe(true);
    appendLiveHistoryMessageToConversationDomainRuntime({ vm: f.vm, actorKey: f.actor.key, actorId: f.actor.id,
      message: { role: "user", content: "continue" } });
    await aiAgentLoopStreaming({ vm: f.vm, actor: f.actor, messages: [] });
    expect(contexts[1]!.primary).toMatchObject({ kind: "stateful_incremental", previousResponseId: "fact-response-1" });
    expect(contexts[1]!.primary.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }]);
    expect(f.conversation.promptStateSignal.get()["fact-presentation::main"].generations).toHaveLength(2);
  });
});
