import { describe, expect, it } from "bun:test";

import {
  buildActorSurfaceProjection,
  createActorSurfaceFacade,
  createActor,
  createVM,
} from "@cell/ai-core-logic";

describe("actor surface projection", () => {
  it("separates foreground conversation lanes from materialized runtime actor lanes", () => {
    const primary = createActor({
      key: "primary",
      id: "actor-primary",
      type: "primary",
      agentName: "Main Agent",
      pendingQuestionnaires: {
        q_primary: {
          questionnaireId: "q_primary",
          toolCallId: "tool-primary",
          kind: "approval",
          title: "Primary check",
          suspendPolicy: "pause_all",
          questions: [],
        },
      },
    });
    const memberActor = createActor({
      key: "member-alice",
      id: "actor-alice",
      type: "delegate",
      agentName: "Alice",
      identity: {
        kind: "member",
        memberId: "alice",
        name: "Alice",
        role: "Reviewer",
        lane: "member",
        agentType: "reviewer",
      },
    });
    const delegate = createActor({
      key: "delegate-1",
      id: "actor-delegate",
      type: "delegate",
      parentKey: "primary",
      agentName: "Delegate Worker",
      stream: {} as any,
      pendingQuestionnaires: {
        q_delegate: {
          questionnaireId: "q_delegate",
          toolCallId: "tool-delegate",
          kind: "approval",
          title: "Delegate approval",
          suspendPolicy: "pause_all",
          questions: [],
        },
      },
    });

    const vm = createVM({
      controlActorKey: primary.key,
      actors: {
        [primary.key]: primary,
        [memberActor.key]: memberActor,
        [delegate.key]: delegate,
      },
      sessionState: {
        memberRoster: {
          alice: {
            memberId: "alice",
            name: "Alice",
            role: "Reviewer",
            agentType: "reviewer",
            lane: "member",
            fiberId: "fiber-alice",
            actorKey: memberActor.key,
            actorId: memberActor.id,
            createdAt: 1,
            lastActiveAt: 2,
            lifecycleState: "active",
          },
          bob: {
            memberId: "bob",
            name: "Bob",
            role: "Builder",
            agentType: "builder",
            lane: "member",
            fiberId: "fiber-bob",
            actorKey: "member-bob",
            actorId: "actor-bob",
            createdAt: 1,
            lastActiveAt: 1,
            lifecycleState: "active",
          },
        },
        holons: {
          core: {
            holonId: "core",
            governance: "leader_led",
            name: "Core Team",
            memberIds: ["alice", "bob"],
            leaderMemberId: "alice",
            watchState: "watched",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
    });

    const projection = buildActorSurfaceProjection(vm);

    expect(projection.conversationLanes.map((lane) => lane.laneId)).toEqual([
      "lane:primary",
      "lane:member:alice",
      "lane:member:bob",
      "lane:holon:core",
    ]);

    const primaryLane = projection.conversationLanes.find((lane) => lane.laneId === "lane:primary");
    expect(primaryLane).toMatchObject({
      actorId: "actor-primary",
      actorKey: "primary",
      backendIdentity: { kind: "primary", name: "Main Agent" },
      initialized: true,
      kind: "primary",
      status: "waiting_for_human",
    });

    const bobLane = projection.conversationLanes.find((lane) => lane.laneId === "lane:member:bob");
    expect(bobLane).toMatchObject({
      actorId: undefined,
      actorKey: undefined,
      backendIdentity: {
        agentType: "builder",
        kind: "member",
        memberId: "bob",
        name: "Bob",
      },
      initialized: false,
      kind: "member",
    });

    expect(projection.actorLanes.map((lane) => lane.actorId)).toEqual([
      "actor-primary",
      "actor-alice",
      "actor-delegate",
    ]);
    expect(projection.actorLanes.find((lane) => lane.actorId === "actor-delegate")).toMatchObject({
      actorKey: "delegate-1",
      displayName: "Delegate Worker",
      activeTurnId: "delegate-1:actor-delegate",
      runtimeStatus: "waiting_for_human",
      transcriptKey: {
        actorId: "actor-delegate",
        actorKey: "delegate-1",
      },
    });

    expect(projection.questionnaireSurface.map((item) => item.questionnaireId)).toEqual([
      "q_primary",
      "q_delegate",
    ]);
    expect(projection.questionnaireSurface.find((item) => item.questionnaireId === "q_delegate")).toMatchObject({
      ownerActorId: "actor-delegate",
      ownerActorKey: "delegate-1",
      ownerFiberId: "delegate-1:actor-delegate",
      lifecycleState: "pending",
    });
  });

  it("exposes the same projection through a narrow actor surface facade", () => {
    const primary = createActor({
      key: "primary",
      id: "actor-primary",
      type: "primary",
      agentName: "Main Agent",
    });
    const delegate = createActor({
      key: "delegate-1",
      id: "actor-delegate",
      type: "delegate",
      parentKey: "primary",
      agentName: "Delegate Worker",
    });
    const vm = createVM({
      controlActorKey: primary.key,
      actors: {
        [primary.key]: primary,
        [delegate.key]: delegate,
      },
    });

    const facade = createActorSurfaceFacade(vm);
    const projection = facade.getActorSurface({
      selectedLaneId: "lane:primary",
      selectedActorId: delegate.id,
    });

    expect(projection.selectedTarget).toEqual({
      laneId: "lane:primary",
      actorId: "actor-delegate",
    });
    expect(projection.actorLanes.map((lane) => [lane.actorId, lane.runtimeStatus])).toEqual([
      ["actor-primary", "idle"],
      ["actor-delegate", "idle"],
    ]);
  });

  it("keeps the primary lane stable while projecting a configured backend identity", () => {
    const primary = createActor({
      key: "primary",
      id: "actor-primary",
      type: "primary",
      agentName: "Main Agent",
    });
    const vm = createVM({
      controlActorKey: primary.key,
      actors: {
        [primary.key]: primary,
      },
      sessionState: {
        actorSurface: {
          primaryBackendIdentity: {
            kind: "member",
            memberId: "alice",
            name: "Alice",
            role: "Reviewer",
            agentType: "reviewer",
          },
        },
        memberRoster: {
          alice: {
            memberId: "alice",
            name: "Alice",
            role: "Reviewer",
            agentType: "reviewer",
            lane: "member",
            fiberId: "fiber-alice",
            actorKey: "member-alice",
            actorId: "actor-alice",
            createdAt: 1,
            lastActiveAt: 1,
            lifecycleState: "active",
          },
        },
      },
    });

    const projection = buildActorSurfaceProjection(vm);
    const primaryLane = projection.conversationLanes.find((lane) => lane.laneId === "lane:primary");
    const memberLane = projection.conversationLanes.find((lane) => lane.laneId === "lane:member:alice");

    expect(primaryLane).toMatchObject({
      actorId: "actor-primary",
      backendIdentity: {
        kind: "member",
        memberId: "alice",
        name: "Alice",
      },
      initialized: true,
    });
    expect(memberLane).toMatchObject({
      actorId: undefined,
      initialized: false,
    });
  });

  it("routes selected lane messages and actor scoped cancel through the facade", () => {
    const primary = createActor({
      key: "primary",
      id: "actor-primary",
      type: "primary",
    });
    const delegate = createActor({
      key: "delegate-1",
      id: "actor-delegate",
      type: "delegate",
      parentKey: "primary",
    });
    const vm = createVM({
      controlActorKey: primary.key,
      actors: {
        [primary.key]: primary,
        [delegate.key]: delegate,
      },
    });

    const emitted: Array<{ fiberId: string; signalKind: string; mailbox: { kind: string; payload: unknown } }> = [];
    const facade = createActorSurfaceFacade(vm, {
      emitFiberSignal: (input) => {
        emitted.push({
          fiberId: input.fiberId,
          signalKind: input.signalKind,
          mailbox: input.mailbox as { kind: string; payload: unknown },
        });
        input.actor.send(input.mailbox.kind as any, input.mailbox.payload as any);
      },
      now: () => 123,
    });
    const selected = facade.selectActorSurfaceTarget({ actorId: delegate.id });
    const afterMessage = facade.sendActorHumanMessage({ actorId: delegate.id }, "continue this actor");
    const afterCancel = facade.cancelActorTurn({ actorId: delegate.id });

    expect(selected.selectedActorId).toBe("actor-delegate");
    expect(delegate.peekMailbox("humanInput")).toEqual(["continue this actor"]);
    expect(delegate.peekMailbox("control")).toContainEqual({ kind: "cancel_requested" });
    expect(emitted).toEqual([
      {
        fiberId: "delegate-1:actor-delegate",
        signalKind: "mailbox_enqueue",
        mailbox: { kind: "humanInput", payload: "continue this actor" },
      },
      {
        fiberId: "delegate-1:actor-delegate",
        signalKind: "interrupt_requested",
        mailbox: { kind: "control", payload: { kind: "cancel_requested" } },
      },
    ]);
    expect(primary.peekMailbox("control")).toEqual([]);
    expect(afterMessage.selectedActorId).toBe("actor-delegate");
    expect(afterCancel.actorLanes.find((lane) => lane.actorId === "actor-delegate")).toMatchObject({
      runtimeStatus: "cancel_requested",
    });
  });

  it("materializes an uninitialized member lane before routing human input", () => {
    const primary = createActor({
      key: "primary",
      id: "actor-primary",
      type: "primary",
    });
    const vm = createVM({
      controlActorKey: primary.key,
      actors: {
        [primary.key]: primary,
      },
      sessionState: {
        memberRoster: {
          bob: {
            memberId: "bob",
            name: "Bob",
            role: "Builder",
            agentType: "builder",
            lane: "member",
            fiberId: "fiber-bob",
            actorKey: "member-bob",
            actorId: "actor-bob",
            createdAt: 1,
            lastActiveAt: 1,
            lifecycleState: "active",
          },
        },
      },
    });

    const facade = createActorSurfaceFacade(vm);
    expect(facade.getActorSurface().conversationLanes.find((lane) => lane.laneId === "lane:member:bob")).toMatchObject({
      actorId: undefined,
      initialized: false,
    });
    expect(facade.selectActorSurfaceTarget({ laneId: "lane:member:bob" }).selectedTarget).toEqual({
      laneId: "lane:member:bob",
      actorId: undefined,
    });

    const projection = facade.sendActorHumanMessage({ laneId: "lane:member:bob" }, "work on this");
    const bobActor = vm.actors["member-bob"];

    expect(bobActor).toBeTruthy();
    expect(bobActor.peekMailbox("humanInput")).toEqual(["work on this"]);
    expect(projection.conversationLanes.find((lane) => lane.laneId === "lane:member:bob")).toMatchObject({
      actorId: "actor-bob",
      actorKey: "member-bob",
      initialized: true,
    });
    expect(projection.selectedTarget).toEqual({
      laneId: "lane:member:bob",
      actorId: "actor-bob",
    });
  });

  it("submits questionnaire replies by id to the owning delegate actor", () => {
    const primary = createActor({
      key: "primary",
      id: "actor-primary",
      type: "primary",
    });
    const delegate = createActor({
      key: "delegate-1",
      id: "actor-delegate",
      type: "delegate",
      parentKey: "primary",
      pendingQuestionnaires: {
        q_delegate: {
          questionnaireId: "q_delegate",
          toolCallId: "tool-delegate",
          kind: "approval",
          title: "Delegate approval",
          suspendPolicy: "pause_all",
          questions: [],
        },
      },
      mailboxes: {
        control: [
          {
            kind: "questionnaire_pending",
            questionnaireId: "q_delegate",
            toolCallId: "tool-delegate",
            suspendPolicy: "pause_all",
          },
        ],
      },
    });
    const vm = createVM({
      controlActorKey: primary.key,
      actors: {
        [primary.key]: primary,
        [delegate.key]: delegate,
      },
    });

    const emitted: Array<{ fiberId: string; signalKind: string; mailbox: { kind: string; payload: unknown }; toolCallId?: string }> = [];
    const facade = createActorSurfaceFacade(vm, {
      emitFiberSignal: (input) => {
        emitted.push({
          fiberId: input.fiberId,
          signalKind: input.signalKind,
          mailbox: input.mailbox as { kind: string; payload: unknown },
          toolCallId: input.toolCallId,
        });
        input.actor.send(input.mailbox.kind as any, input.mailbox.payload as any);
      },
      now: () => 456,
    });
    const pending = facade.getActorSurface().questionnaireSurface.find((item) => item.questionnaireId === "q_delegate");
    const submitted = facade.submitQuestionnaireResponse("q_delegate", "approved");

    expect(pending).toMatchObject({
      ownerActorId: "actor-delegate",
      ownerActorKey: "delegate-1",
    });
    expect(submitted.status).toBe("submitted");
    expect(delegate.peekMailbox("toolResult")).toEqual([
      {
        toolCallId: "tool-delegate",
        questionnaireId: "q_delegate",
        content: "approved",
      },
    ]);
    expect(emitted).toEqual([
      {
        fiberId: "delegate-1:actor-delegate",
        signalKind: "mailbox_enqueue",
        mailbox: {
          kind: "toolResult",
          payload: {
            toolCallId: "tool-delegate",
            questionnaireId: "q_delegate",
            content: "approved",
          },
        },
        toolCallId: "tool-delegate",
      },
    ]);
    expect(delegate.pendingQuestionnaires.q_delegate).toBeTruthy();
    expect(primary.peekMailbox("toolResult")).toEqual([]);
    expect(facade.getActorSurface().questionnaireSurface).toEqual([]);
  });
});
