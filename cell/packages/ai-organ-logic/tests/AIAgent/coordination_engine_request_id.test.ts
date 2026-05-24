import { describe, expect, it } from "bun:test";

import {
  AI_AGENT_COORDINATION_DECISIONS,
  AI_AGENT_COORDINATION_KINDS,
  AI_AGENT_COORDINATION_NAMES,
  AI_AGENT_COORDINATION_STATUSES,
} from "@cell/ai-core-logic";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { createVM } from "@cell/ai-core-logic/runtime/runtime";
import { getCoordinationEngine } from "@cell/ai-organ-logic/coordination/CoordinationEngine";

function makeVm() {
  const actor = createActor({ key: `control-${Date.now()}` })
  return createVM({ controlActorKey: actor.key, actors: { [actor.key]: actor } })
}

describe("Member coordination: request_id correlation", () => {
  it("tracks plan approval decisions by request_id without cross-talk", () => {
    const vm = makeVm()
    const engine = getCoordinationEngine();
    engine.__resetForTest?.();

    const a = engine.makeOutbound({
      coordination: AI_AGENT_COORDINATION_NAMES.planApproval,
      kind: AI_AGENT_COORDINATION_KINDS.planRequest,
      payload: { plan: "do A" },
    });
    const b = engine.makeOutbound({
      coordination: AI_AGENT_COORDINATION_NAMES.planApproval,
      kind: AI_AGENT_COORDINATION_KINDS.planRequest,
      payload: { plan: "do B" },
    });

    engine.ingestMemberInbox(vm, { from: "worker", text: a.text, ts: Date.now() });
    engine.ingestMemberInbox(vm, { from: "worker", text: b.text, ts: Date.now() });

    engine.ingestMemberInbox(vm, {
      from: "control",
      text: engine.makeOutbound({
        coordination: AI_AGENT_COORDINATION_NAMES.planApproval,
        kind: AI_AGENT_COORDINATION_KINDS.planReview,
        request_id: a.request_id,
        payload: { decision: AI_AGENT_COORDINATION_DECISIONS.approve, feedback: "ok" },
      }).text,
      ts: Date.now(),
    });

    expect(engine.get(vm, a.request_id)?.status).toBe(AI_AGENT_COORDINATION_STATUSES.approved);
    expect(engine.get(vm, b.request_id)?.status).toBe(AI_AGENT_COORDINATION_STATUSES.pending);
    expect(engine.isApproved(vm, a.request_id)).toBe(true);
    expect(engine.isApproved(vm, b.request_id)).toBe(false);
  });

  it("tracks shutdown handshake by request_id", () => {
    const vm = makeVm()
    const engine = getCoordinationEngine();
    engine.__resetForTest?.();

    const req = engine.makeOutbound({
      coordination: AI_AGENT_COORDINATION_NAMES.shutdown,
      kind: AI_AGENT_COORDINATION_KINDS.shutdownRequest,
      payload: { reason: "done" },
    });

    engine.ingestMemberInbox(vm, { from: "control", text: req.text, ts: Date.now() });

    const resp = engine.makeOutbound({
      coordination: AI_AGENT_COORDINATION_NAMES.shutdown,
      kind: AI_AGENT_COORDINATION_KINDS.shutdownResponse,
      request_id: req.request_id,
      payload: { decision: AI_AGENT_COORDINATION_DECISIONS.reject, reason: "still working" },
    });
    engine.ingestMemberInbox(vm, { from: "worker", text: resp.text, ts: Date.now() });

    expect(engine.get(vm, req.request_id)?.status).toBe(AI_AGENT_COORDINATION_STATUSES.rejected);
    expect(engine.get(vm, req.request_id)?.decision).toBe(AI_AGENT_COORDINATION_DECISIONS.reject);
  });
});
