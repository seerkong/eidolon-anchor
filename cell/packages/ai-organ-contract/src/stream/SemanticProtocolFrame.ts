import type {
  AiAgentVmDomainRxEvent,
  AiAgentVmReadonlyRxSignal,
  AiAgentVmRxStream,
  AiAgentVmTraceSummaryData,
  AiAgentVmUsageData,
} from "@cell/ai-core-contract/runtime/AiAgentVm";
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";

export type SemanticProtocolFrameSource = "semantic" | "history" | "prompt" | "session";

export type SemanticProtocolFrame =
  | {
      kind: "semantic";
      source: "semantic";
      eventType: SemanticEvent["event_type"];
      trace: SemanticEvent["trace"];
      actor: SemanticEvent["actor"];
      team: SemanticEvent["team"];
      event: SemanticEvent;
    }
  | {
      kind: "domain";
      source: Exclude<SemanticProtocolFrameSource, "semantic">;
      eventType: string;
      event: AiAgentVmDomainRxEvent;
    };

export type SemanticProtocolBinding = {
  protocolFrames: AiAgentVmRxStream<SemanticProtocolFrame>;
  usage: AiAgentVmReadonlyRxSignal<AiAgentVmUsageData>;
  traceSummary: AiAgentVmReadonlyRxSignal<AiAgentVmTraceSummaryData>;
  dispose: () => void;
};
