import { parseArgs } from "node:util";

import type { SemanticEvent } from "../cell/packages/ai-core-contract/src/stream/semantic";
import { AgentEventGraph } from "../cell/packages/ai-core-logic/src/stream/AgentEventGraph";
import { MessageHistoryGraph } from "../cell/packages/ai-core-logic/src/stream/MessageHistoryGraph";
import { createActor } from "../cell/packages/ai-core-logic/src/runtime/actor";
import { createVM, ensureVmRxData } from "../cell/packages/ai-core-logic/src/runtime/runtime";
import { buildRuntimeSemanticBase } from "../cell/packages/ai-core-logic/src/stream/runtime/SemanticRuntimeSupport";
import { IngressStreams } from "../cell/packages/symbiont-logic/src/stream/IngressStreams";
import { SemanticStreamGraph } from "../cell/packages/ai-organ-logic/src/stream/SemanticStreamPipeline";
import { createObservableGraph } from "../cell/packages/ai-organ-logic/src/observability/createObservableGraph";

const OWNERS = [
  "ingress-timeline",
  "semantic-stream-graph",
  "observable-trace-log",
  "agent-event-graph",
  "message-history-graph",
  "rx-semantic-log",
  "rx-history-log",
  "rx-prompt-log",
  "rx-session-log",
  "rx-observability-log",
  "rx-observability-error-log",
  "rx-control-signal-log",
  "rx-all-logs",
  "session-semantic-chain",
] as const;

type Owner = typeof OWNERS[number];

type RetentionOwner = {
  append: (event: SemanticEvent, serializedEvent: string, index: number) => void;
  count: () => number;
  entries: () => readonly unknown[];
  dispose: () => void;
};

function semanticEvent(index: number, payloadChars: number): SemanticEvent {
  const prefix = `${index.toString().padStart(8, "0")}:`;
  const message = prefix + "x".repeat(Math.max(0, payloadChars - prefix.length));
  return {
    ...buildRuntimeSemanticBase({ agentKey: "main", agentActorId: "actor-main" }, index + 1),
    event_type: "semantic_notice",
    message,
    level: "info",
  };
}

function createOwner(owner: Owner): RetentionOwner {
  if (owner === "ingress-timeline") {
    const ingress = new IngressStreams();
    const streams = [ingress.control, ingress.think, ingress.content, ingress.tool];
    const foundation = ingress.timeline.getTimelineFoundation();
    return {
      append: (_event, serializedEvent, index) => {
        void streams[index % streams.length]!.send("semantic", serializedEvent);
      },
      count: () => foundation.size(),
      entries: () => foundation.entries(),
      dispose: () => {
        void Promise.all([
          ingress.control.close(),
          ingress.think.close(),
          ingress.content.close(),
          ingress.tool.close(),
          ingress.timeline.close(),
        ]);
      },
    };
  }

  if (owner === "agent-event-graph") {
    const graph = new AgentEventGraph();
    const eventLog = (graph as unknown as {
      eventLog: { size: () => number; entries: () => readonly unknown[] };
    }).eventLog;
    return {
      append: (event) => graph.emit(event),
      count: () => eventLog.size(),
      entries: () => eventLog.entries(),
      dispose: () => graph.dispose(),
    };
  }

  if (owner === "semantic-stream-graph") {
    const graph = new SemanticStreamGraph({ agentKey: "main", agentActorId: "actor-main" });
    const eventLog = (graph as unknown as {
      eventLog: {
        append: (event: SemanticEvent) => void;
        size: () => number;
        entries: () => readonly unknown[];
      };
    }).eventLog;
    return {
      append: (event) => eventLog.append(event),
      count: () => eventLog.size(),
      entries: () => eventLog.entries(),
      dispose: () => graph.dispose(),
    };
  }

  if (owner === "observable-trace-log") {
    const observable = createObservableGraph();
    observable.graph.addSignal("retention-audit", 0);
    return {
      append: (_event, _serializedEvent, index) => observable.graph.set("retention-audit", index),
      count: () => observable.traceLog.size(),
      entries: () => observable.traceLog.entries(),
      dispose: () => observable.dispose(),
    };
  }

  if (owner === "message-history-graph") {
    const graph = new MessageHistoryGraph();
    const inputLog = (graph as unknown as {
      inputLog: { size: () => number; entries: () => readonly unknown[] };
    }).inputLog;
    return {
      append: (event) => graph.consumeSemanticEvent(event),
      count: () => inputLog.size(),
      entries: () => inputLog.entries(),
      dispose: () => graph.dispose(),
    };
  }

  const actor = createActor({ key: "main" });
  const rxEventBus = new AgentEventGraph();
  const vm = createVM({
    controlActorKey: "main",
    actors: { main: actor },
    eventBus: rxEventBus,
  });
  const initializedRx = ensureVmRxData(vm);
  type InspectableRxStream = {
    append: (event: unknown) => void;
    retainedCount: () => number;
  };
  const rxStreams: Record<string, InspectableRxStream> = {
    "rx-semantic-log": initializedRx.privateRxData.semanticEvents as unknown as InspectableRxStream,
    "rx-history-log": initializedRx.privateRxData.historyDomainStream as unknown as InspectableRxStream,
    "rx-prompt-log": initializedRx.privateRxData.promptDomainStream as unknown as InspectableRxStream,
    "rx-session-log": initializedRx.privateRxData.sessionDomainStream as unknown as InspectableRxStream,
    "rx-observability-log": initializedRx.privateRxData.observabilityRecords as unknown as InspectableRxStream,
    "rx-observability-error-log": initializedRx.privateRxData.observabilityErrors as unknown as InspectableRxStream,
    "rx-control-signal-log": initializedRx.privateRxData.controlSignals as unknown as InspectableRxStream,
  };
  const selectedRxStreams = owner === "rx-all-logs"
    ? Object.values(rxStreams)
    : owner in rxStreams
      ? [rxStreams[owner]!]
      : [];
  const rxOwner: RetentionOwner = {
    append: (event) => {
      for (const stream of selectedRxStreams) stream.append(event);
    },
    count: () => selectedRxStreams.reduce((total, stream) => total + stream.retainedCount(), 0),
    entries: () => selectedRxStreams.map((stream) => ({ retainedCount: stream.retainedCount() })),
    dispose: () => {
      initializedRx.privateRxBinding.dispose();
      initializedRx.publicRxBinding.dispose();
      rxEventBus.dispose();
    },
  };
  if (selectedRxStreams.length > 0) return rxOwner;

  const eventBus = new AgentEventGraph();
  const historyGraph = new MessageHistoryGraph();
  const eventBusLog = (eventBus as unknown as {
    eventLog: { size: () => number; entries: () => readonly unknown[] };
  }).eventLog;
  const historyLog = (historyGraph as unknown as {
    inputLog: { size: () => number; entries: () => readonly unknown[] };
  }).inputLog;
  const historySubscription = eventBus.addConsumer((event) => historyGraph.consumeSemanticEvent(event));
  const semanticRxStream = rxStreams["rx-semantic-log"]!;
  const rxSubscription = eventBus.addConsumer((event) => semanticRxStream.append(event));
  return {
    append: (event) => eventBus.emit(event),
    count: () => eventBusLog.size() + historyLog.size() + semanticRxStream.retainedCount(),
    entries: () => [eventBusLog.entries(), historyLog.entries(), semanticRxStream.retainedCount()],
    dispose: () => {
      historySubscription.unsubscribe();
      rxSubscription.unsubscribe();
      historyGraph.dispose();
      eventBus.dispose();
      initializedRx.privateRxBinding.dispose();
      initializedRx.publicRxBinding.dispose();
      rxEventBus.dispose();
    },
  };
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function isOwner(value: string | undefined): value is Owner {
  return OWNERS.includes(value as Owner);
}

export function runRetentionAudit(input: {
  owner: Owner;
  count: number;
  payloadChars: number;
}) {
  const retained = createOwner(input.owner);
  Bun.gc(true);
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();

  for (let index = 0; index < input.count; index += 1) {
    const event = semanticEvent(index, input.payloadChars);
    retained.append(event, JSON.stringify(event), index);
  }

  const elapsedMs = performance.now() - startedAt;
  Bun.gc(true);
  const heapAfter = process.memoryUsage().heapUsed;
  const retainedCount = retained.count();
  const serializedBytes = Buffer.byteLength(JSON.stringify(retained.entries()), "utf8");
  retained.dispose();

  return {
    owner: input.owner,
    inputCount: input.count,
    retainedCount,
    payloadChars: input.payloadChars,
    serializedBytes,
    serializedBytesPerEntry: retainedCount === 0 ? 0 : serializedBytes / retainedCount,
    heapUsedDeltaBytes: heapAfter - heapBefore,
    heapUsedDeltaBytesPerEntry: retainedCount === 0 ? 0 : (heapAfter - heapBefore) / retainedCount,
    heapUsedDeltaBytesPerInput: (heapAfter - heapBefore) / input.count,
    appendElapsedMs: elapsedMs,
    measurement: "isolated synthetic process; GC before/after; JSON bytes are a comparison metric, not RSS attribution",
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      owner: { type: "string" },
      count: { type: "string" },
      "payload-chars": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!isOwner(values.owner)) {
    throw new Error(`--owner must be one of: ${OWNERS.join(", ")}`);
  }
  console.log(JSON.stringify(runRetentionAudit({
    owner: values.owner,
    count: positiveInteger(values.count, "--count", 50_000),
    payloadChars: positiveInteger(values["payload-chars"], "--payload-chars", 96),
  })));
}
