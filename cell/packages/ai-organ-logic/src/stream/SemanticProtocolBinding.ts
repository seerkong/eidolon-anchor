import type { AiAgentVmDomainRxEvent, AiAgentVmRxSubscription } from "@cell/ai-core-contract/runtime/AiAgentVm";
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import type {
  SemanticProtocolBinding,
  SemanticProtocolFrame,
} from "@cell/ai-organ-contract/stream/SemanticProtocolFrame";
import { ensureVmRxData, type AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";

type WritableProtocolFrameStream = SemanticProtocolBinding["protocolFrames"] & {
  append: (frame: SemanticProtocolFrame) => void;
};

export function createSemanticProtocolBinding(vm: AiAgentVm): SemanticProtocolBinding {
  const { publicRxData } = ensureVmRxData(vm);
  const protocolFrames = createProtocolFrameStream();
  const subscriptions: AiAgentVmRxSubscription[] = [
    publicRxData.semanticEvents.subscribe((event) => protocolFrames.append(toSemanticProtocolFrame(event))),
    publicRxData.historyDomainStream.subscribe((event) => protocolFrames.append(toDomainProtocolFrame("history", event))),
    publicRxData.promptDomainStream.subscribe((event) => protocolFrames.append(toDomainProtocolFrame("prompt", event))),
    publicRxData.sessionDomainStream.subscribe((event) => protocolFrames.append(toDomainProtocolFrame("session", event))),
  ];
  let disposed = false;

  return {
    protocolFrames: readonlyProtocolFrameStream(protocolFrames),
    usage: publicRxData.usage,
    traceSummary: publicRxData.traceSummary,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const subscription of subscriptions.splice(0)) {
        subscription.unsubscribe();
      }
      protocolFrames.dispose();
    },
  };
}

function toSemanticProtocolFrame(event: SemanticEvent): SemanticProtocolFrame {
  return {
    kind: "semantic",
    source: "semantic",
    eventType: event.event_type,
    trace: event.trace,
    actor: event.actor,
    team: event.team,
    event,
  };
}

function toDomainProtocolFrame(
  source: "history" | "prompt" | "session",
  event: AiAgentVmDomainRxEvent,
): SemanticProtocolFrame {
  return {
    kind: "domain",
    source,
    eventType: event.type,
    event,
  };
}

function createProtocolFrameStream(): WritableProtocolFrameStream & { dispose: () => void } {
  const listeners = new Set<(frame: SemanticProtocolFrame) => void>();
  return {
    append: (frame) => {
      for (const listener of Array.from(listeners)) {
        listener(frame);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return {
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
    dispose: () => {
      listeners.clear();
    },
  };
}

function readonlyProtocolFrameStream(
  stream: SemanticProtocolBinding["protocolFrames"],
): SemanticProtocolBinding["protocolFrames"] {
  return {
    subscribe: (listener) => stream.subscribe(listener),
  };
}
