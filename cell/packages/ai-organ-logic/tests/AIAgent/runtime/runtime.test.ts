import { describe, expect, it } from "bun:test";

import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import {
  AI_AGENT_VM_FACET_OWNERSHIP,
  bindVmDomainRxStreams,
  createVM,
  ensureVmRxData,
  getAiRuntimeFacet,
  ensureVmRuntimeContext,
  ensureVmSessionState,
  getPlatformRuntimeVm,
} from "@cell/ai-core-logic/runtime/runtime";
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry";
import { SkillRegistry } from "@cell/ai-core-logic/runtime/SkillRegistry";
import { McpRegistry } from "@cell/ai-core-logic/runtime/McpRegistry";

describe("createVM", () => {
  it("creates runtime with registry instances and actors", () => {
    const actor = createActor({ key: "main" });
    const bus = new AgentEventGraph();

      const vm = createVM({
        controlActorKey: "main",
        actors: { main: actor },
        eventBus: bus,
        registries: {
          skillRegistry: new SkillRegistry(),
          agentRegistry: new AgentRegistry({ code: { name: "code", description: "Code agent", tools: "*", prompt: [] } }),
          mcpRegistry: new McpRegistry({ example: {} }),
        },
      });

    expect((vm as any).controlActorKey).toBe("main");
    expect(vm.controlActorKey).toBe("main");
    expect(vm.eventBus).toBe(bus);
    expect(Object.isFrozen(vm.actors)).toBe(false);
    expect(vm.registries.skillRegistry).toBeInstanceOf(SkillRegistry);
    expect(vm.registries.agentRegistry).toBeInstanceOf(AgentRegistry);
    expect(vm.registries.mcpRegistry).toBeInstanceOf(McpRegistry);
    expect(AgentRegistry.get(vm.registries.agentRegistry, "code")?.name).toBe("code");
      expect(SkillRegistry.keys(vm.registries.skillRegistry)).toEqual([]);
    expect(McpRegistry.keys(vm.registries.mcpRegistry)).toEqual(["example"]);
    expect(vm.actorRuntime).toBeDefined();
    expect(vm.actorRuntime.has("main")).toBe(true);
    expect(vm.sessionState.memberRoster).toEqual({});
  });

  it("exposes controlActorKey as the formal control-actor runtime pointer", () => {
    const actor = createActor({ key: "control" })
    const vm = createVM({
      controlActorKey: "control",
      actors: { control: actor },
    })

    expect((vm as any).controlActorKey).toBe("control")
    expect(vm.controlActorKey).toBe("control")
  })

  it("splits platform ownership from the ai facet without introducing a second vm truth", () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      aiFacet: {
        sessionState: {
          detachedActors: {
            "task-1": {
              taskId: "task-1",
              kind: "delegate",
              status: "running",
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        runtimeContext: {
          interactiveTurnActive: true,
        },
      },
    });

    const platformVm = getPlatformRuntimeVm(vm);
    const aiFacet = getAiRuntimeFacet(vm);

    expect(AI_AGENT_VM_FACET_OWNERSHIP.platform).toContain("actorRuntime");
    expect(AI_AGENT_VM_FACET_OWNERSHIP.ai).toEqual(["aiFacet", "sessionState", "runtimeContext"]);
    expect(AI_AGENT_VM_FACET_OWNERSHIP.actors).toEqual(["controlActorKey", "actors", "actorRuntime"]);
    expect(AI_AGENT_VM_FACET_OWNERSHIP.holonRuntime).toEqual(["holonRuntime"]);
    expect(AI_AGENT_VM_FACET_OWNERSHIP.runtimeKnobs).toEqual(["options", "effects", "callbacks"]);
    expect(AI_AGENT_VM_FACET_OWNERSHIP.nonRxData).toEqual(["outerCtx", "innerCtx", "immutableSnapshot", "mutableSnapshot"]);
    expect(AI_AGENT_VM_FACET_OWNERSHIP.rxData).toEqual(["eventBus", "publicRxData", "privateRxData", "publicRxBinding", "privateRxBinding"]);
    expect(platformVm.actorRuntime).toBe(vm.actorRuntime);
    expect(aiFacet.sessionState).toBe(vm.sessionState);
    expect(aiFacet.runtimeContext).toBe(vm.runtimeContext);
    expect(aiFacet.sessionState.detachedActors["task-1"]?.status).toBe("running");
    expect(aiFacet.runtimeContext.interactiveTurnActive).toBe(true);

    vm.sessionState.detachedActors["task-2"] = {
      taskId: "task-2",
      kind: "bash",
      status: "completed",
      createdAt: 2,
      updatedAt: 2,
    };
    vm.runtimeContext = {
      ...vm.runtimeContext,
      interactiveTurnActive: false,
    };

    expect(getAiRuntimeFacet(vm).sessionState.detachedActors["task-2"]?.status).toBe("completed");
    expect(getAiRuntimeFacet(vm).runtimeContext.interactiveTurnActive).toBe(false);
    expect(vm.actorRuntime.getFacet<typeof aiFacet>("cell.vm.aiFacet")).toBe(vm.aiFacet);
    expect(vm.actorRuntime.getFacet<typeof vm.runtimeContext>("cell.vm.runtimeContext")).toBe(vm.runtimeContext);
  });

  it("keeps legacy ai facet accessors backed by holonRuntime", () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      aiFacet: {
        sessionState: {
          memberRoster: {
            member1: {
              memberId: "member1",
              name: "Member One",
              role: "helper",
              agentType: "code",
              lane: "member",
              fiberId: "fiber-member1",
              actorKey: "member1",
              actorId: "actor-member1",
              createdAt: 1,
              lastActiveAt: 1,
              lifecycleState: "active",
            },
          },
        },
        runtimeContext: {
          interactiveTurnActive: true,
        },
      },
    });

    expect(vm.holonRuntime.aiFacet).toBe(vm.aiFacet);
    expect(vm.holonRuntime.sessionState).toBe(vm.sessionState);
    expect(vm.holonRuntime.runtimeContext).toBe(vm.runtimeContext);
    expect(ensureVmSessionState(vm)).toBe(vm.holonRuntime.sessionState);
    expect(ensureVmRuntimeContext(vm)).toBe(vm.holonRuntime.runtimeContext);

    vm.sessionState.detachedActors["task-holon"] = {
      taskId: "task-holon",
      kind: "delegate",
      status: "completed",
      createdAt: 2,
      updatedAt: 3,
    };
    expect(vm.holonRuntime.sessionState.detachedActors["task-holon"]?.status).toBe("completed");

    vm.runtimeContext = {
      ...vm.runtimeContext,
      interactiveTurnActive: false,
    };
    expect(vm.holonRuntime.runtimeContext).toBe(vm.runtimeContext);
    expect(vm.aiFacet.runtimeContext).toBe(vm.holonRuntime.runtimeContext);
    expect(ensureVmRuntimeContext(vm).interactiveTurnActive).toBe(false);
  });

  it("keeps legacy inner context accessors backed by innerCtx", () => {
    const actor = createActor({ key: "main" });
    const registries = {
      skillRegistry: new SkillRegistry(),
      agentRegistry: new AgentRegistry({ code: { name: "code", description: "Code agent", tools: "*", prompt: [] } }),
      mcpRegistry: new McpRegistry({ example: {} }),
    };
    const mcpManager = { kind: "mcp-manager" } as any;
    const recovery = { restoredFromSnapshot: true, restoredAt: 42 };

    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      registries,
      mcpManager,
      recovery,
    });

    expect(vm.innerCtx.registries).toBe(vm.registries);
    expect(vm.innerCtx.mcpManager).toBe(vm.mcpManager);
    expect(vm.innerCtx.recovery).toBe(vm.recovery);
    expect(AgentRegistry.get(vm.registries.agentRegistry, "code")?.name).toBe("code");

    const nextRegistries = {
      toolRegistry: null,
      skillRegistry: new SkillRegistry(),
      agentRegistry: new AgentRegistry({ review: { name: "review", description: "Review agent", tools: "*", prompt: [] } }),
      mcpRegistry: new McpRegistry(),
    };
    vm.registries = nextRegistries;
    vm.mcpManager = undefined;
    vm.recovery = { restoredFromSnapshot: false };

    expect(vm.innerCtx.registries).toBe(nextRegistries);
    expect(AgentRegistry.get(vm.innerCtx.registries.agentRegistry, "review")?.name).toBe("review");
    expect(vm.innerCtx.mcpManager).toBeUndefined();
    expect(vm.innerCtx.recovery?.restoredFromSnapshot).toBe(false);
  });

  it("exposes rx data seams as empty before ensureVmRxData initializes them", () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
    });

    expect(vm.privateRxData).toBeNull();
    expect(vm.publicRxData).toBeNull();
    expect(vm.privateRxBinding).toBeNull();
    expect(vm.publicRxBinding).toBeNull();
    expect(AI_AGENT_VM_FACET_OWNERSHIP.rxData).toEqual([
      "eventBus",
      "publicRxData",
      "privateRxData",
      "publicRxBinding",
      "privateRxBinding",
    ]);
  });

  it("initializes public/private rx data and keeps public streams readonly", () => {
    const actor = createActor({ key: "main" });
    const bus = new AgentEventGraph();
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      eventBus: bus,
    });

    const initialized = ensureVmRxData(vm);

    expect(vm.privateRxData).toBe(initialized.privateRxData);
    expect(vm.publicRxData).toBe(initialized.publicRxData);
    expect(vm.privateRxBinding).toBe(initialized.privateRxBinding);
    expect(vm.publicRxBinding).toBe(initialized.publicRxBinding);
    expect(vm.privateRxData).not.toBeNull();
    expect(vm.publicRxData).not.toBeNull();
    expect(typeof vm.privateRxData?.semanticEvents.append).toBe("function");
    expect("append" in (vm.publicRxData?.semanticEvents as any)).toBe(false);

    const events: unknown[] = [];
    const subscription = vm.publicRxData!.semanticEvents.subscribe((event) => events.push(event));
    bus.emitUserInput({ key: "main", id: actor.id }, "hello rx");

    expect(events).toHaveLength(1);
    expect(vm.publicRxData!.traceSummary.get().eventCount).toBe(1);
    expect(vm.publicRxData!.usage.get().total_tokens).toBe(0);

    vm.privateRxData!.usage.set((prev) => ({
      ...prev,
      total_tokens: prev.total_tokens + 7,
      is_estimated: true,
    }));
    expect(vm.publicRxData!.usage.get().total_tokens).toBe(7);
    expect(vm.publicRxData!.usage.get().is_estimated).toBe(true);

    subscription.unsubscribe();
  });

  it("disposes rx bindings idempotently", () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
      eventBus: new AgentEventGraph(),
    });
    const { privateRxBinding, publicRxBinding } = ensureVmRxData(vm);

    expect(() => {
      privateRxBinding.dispose();
      privateRxBinding.dispose();
      publicRxBinding.dispose();
      publicRxBinding.dispose();
    }).not.toThrow();
  });

  it("bridges optional conversation domain streams through public rx data and disposes cleanly", () => {
    const actor = createActor({ key: "main" });
    const vm = createVM({
      controlActorKey: "main",
      actors: { main: actor },
    });
    const historySource = createDomainRxSource();
    const promptSource = createDomainRxSource();
    const sessionSource = createDomainRxSource();
    const { publicRxData } = ensureVmRxData(vm);
    const received = {
      history: [] as unknown[],
      prompt: [] as unknown[],
      session: [] as unknown[],
    };

    const publicSubscriptions = [
      publicRxData.historyDomainStream.subscribe((event) => received.history.push(event)),
      publicRxData.promptDomainStream.subscribe((event) => received.prompt.push(event)),
      publicRxData.sessionDomainStream.subscribe((event) => received.session.push(event)),
    ];
    const binding = bindVmDomainRxStreams({
      vm,
      history: historySource.stream,
      prompt: promptSource.stream,
      session: sessionSource.stream,
    });

    historySource.emit({ type: "actor_history_generation_created", payload: { id: "h1" }, occurredAt: 1 });
    promptSource.emit({ type: "actor_prompt_generation_created", payload: { id: "p1" }, occurredAt: 2 });
    sessionSource.emit({ type: "conversation_session_selected", payload: { id: "s1" }, occurredAt: 3 });

    expect(received.history).toEqual([
      { type: "actor_history_generation_created", payload: { id: "h1" }, occurredAt: 1 },
    ]);
    expect(received.prompt).toEqual([
      { type: "actor_prompt_generation_created", payload: { id: "p1" }, occurredAt: 2 },
    ]);
    expect(received.session).toEqual([
      { type: "conversation_session_selected", payload: { id: "s1" }, occurredAt: 3 },
    ]);

    binding.dispose();
    binding.dispose();
    historySource.emit({ type: "actor_history_generation_created", payload: { id: "h2" }, occurredAt: 4 });

    expect(received.history).toHaveLength(1);
    expect(historySource.unsubscribeCount).toBe(1);
    expect(promptSource.unsubscribeCount).toBe(1);
    expect(sessionSource.unsubscribeCount).toBe(1);

    for (const subscription of publicSubscriptions) {
      subscription.unsubscribe();
    }
  });
});

type TestDomainRxEvent = { type: string; payload?: unknown; occurredAt?: string | number };
type TestDomainRxListener = (event: TestDomainRxEvent) => void;

function createDomainRxSource(): {
  stream: { subscribe: (listener: TestDomainRxListener) => { unsubscribe: () => void } };
  emit: (event: TestDomainRxEvent) => void;
  readonly unsubscribeCount: number;
} {
  const listeners = new Set<TestDomainRxListener>();
  let unsubscribeCount = 0;

  return {
    stream: {
      subscribe: (listener) => {
        listeners.add(listener);
        return {
          unsubscribe: () => {
            if (listeners.delete(listener)) {
              unsubscribeCount += 1;
            }
          },
        };
      },
    },
    emit: (event) => {
      for (const listener of Array.from(listeners)) {
        listener(event);
      }
    },
    get unsubscribeCount() {
      return unsubscribeCount;
    },
  };
}
