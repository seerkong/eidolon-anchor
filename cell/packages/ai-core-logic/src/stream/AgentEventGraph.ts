import { AppendOnlyEventLog } from "depa-data-graph-core";

import type { AutonomousHolonClaimPayload, AutonomousHolonIdleExitPayload } from "@cell/ai-core-contract/runtime/AutonomousHolon";
import type { DetachedActorKind, DetachedActorTerminalStatus } from "@cell/ai-core-contract/runtime/DetachedActor";
import type { QuestionnaireRequestPayload, QuestionnaireResultPayload } from "@cell/ai-core-contract/runtime/Questionnaire";
import type { VmThreadGoalRecord } from "@cell/ai-core-contract/runtime/AiAgentVm";
import type { IngressSource, JsonToolCall, ParsedXmlToolCall, ToolCallType } from "@cell/ai-core-contract/stream/ingressAdapterTypes";
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";

import {
  buildRuntimeSemanticBase,
  buildSemanticQuestionnaireRequest,
  inferApproved,
  mapRuntimeProtocolToSemanticEvents,
  toSemanticQuoteSource,
  toSemanticToolCall,
} from "../stream/runtime/SemanticRuntimeSupport";

export type ActorLike = {
  key: string;
  id: string;
};

export type Subscription = {
  unsubscribe: () => void;
};

type SemanticEventListener = {
  next: (event: SemanticEvent) => void;
  error: (error: Error) => void;
  complete: () => void;
};

export class AgentEventGraph {
  private readonly eventLog = new AppendOnlyEventLog<SemanticEvent>();
  private readonly consumers = new Set<{
    subscription: Subscription;
    listener: SemanticEventListener;
  }>();
  private done = false;
  private terminalError: Error | null = null;

  constructor() {
  }

  addConsumer(
    onNext?: (event: SemanticEvent) => void,
    onError?: (error: Error) => void,
    onComplete?: () => void
  ): Subscription {
    if (this.done) {
      if (this.terminalError) {
        (onError ?? (() => {}))(this.terminalError);
      } else {
        (onComplete ?? (() => {}))();
      }
      return { unsubscribe: () => {} };
    }

    const listener: SemanticEventListener = {
      next: onNext ?? (() => {}),
      error: onError ?? (() => {}),
      complete: onComplete ?? (() => {}),
    };

    const stream = this.eventLog.stream({ replay: false });
    const subscription = stream.subscribe({
      next: (entry) => {
        if (this.done) {
          return;
        }
        listener.next(entry.value);
      },
      error: (error) => {
        listener.error(error instanceof Error ? error : new Error(String(error)));
      },
      complete: () => {
        listener.complete();
      },
    });

    const consumer = {
      subscription: {
        unsubscribe: () => {
          subscription.unsubscribe();
        },
      },
      listener,
    };

    this.consumers.add(consumer);
    return {
      unsubscribe: () => {
        subscription.unsubscribe();
        this.consumers.delete(consumer);
      },
    };
  }

  emit(event: SemanticEvent): void {
    if (this.done) {
      return;
    }

    if (!event.actor.actor_name || !event.actor.actor_id) {
      throw new Error("SemanticEvent missing actor metadata");
    }

    this.eventLog.append(event);
  }

  complete(): void {
    if (this.done) {
      return;
    }

    this.done = true;
    for (const consumer of Array.from(this.consumers)) {
      consumer.listener.complete();
      consumer.subscription.unsubscribe();
    }
    this.consumers.clear();
  }

  error(err: Error): void {
    if (this.done) {
      return;
    }

    this.done = true;
    this.terminalError = err;
    for (const consumer of Array.from(this.consumers)) {
      consumer.listener.error(err);
      consumer.subscription.unsubscribe();
    }
    this.consumers.clear();
  }

  dispose(): void {
    this.done = true;
    for (const consumer of Array.from(this.consumers)) {
      consumer.subscription.unsubscribe();
    }
    this.consumers.clear();
    this.eventLog.dispose();
  }

  emitThinkStart(actor: ActorLike): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_think_start",
    });
  }

  emitThinkDelta(actor: ActorLike, text: string): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_think_delta",
      text,
    });
  }

  emitThinkEnd(actor: ActorLike): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_think_end",
    });
  }

  emitContentStart(actor: ActorLike): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_content_start",
    });
  }

  emitContentDelta(actor: ActorLike, text: string): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_content_delta",
      text,
    });
  }

  emitContentEnd(actor: ActorLike): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_content_end",
    });
  }

  emitQuote(actor: ActorLike, text: string, source: IngressSource): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_quote",
      text,
      source: toSemanticQuoteSource(source),
    });
  }

  emitToolCall(
    actor: ActorLike,
    toolCall: ParsedXmlToolCall | JsonToolCall | undefined,
    _source: IngressSource,
    type: ToolCallType
  ): void {
    if (!toolCall) {
      return;
    }

    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_tool_call_planned",
      tool_call: toSemanticToolCall(toolCall, type),
    });
  }

  emitToolCallError(actor: ActorLike, errors: string[], _source: IngressSource): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_error",
      error: {
        code: "",
        message: errors.join("; "),
        retryable: false,
        provider_status: 0,
        detail_text: "",
      },
    });
  }

  emitToolCallStart(actor: ActorLike, toolName: string, toolCallId: string, argumentsText: string): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_tool_call_start",
      tool_call: {
        tool_call_id: toolCallId,
        tool_name: toolName,
        arguments_text: argumentsText,
        protocol: "unknown",
        call_kind: "unknown",
        raw_payload_text: "",
      },
    });
  }

  emitToolCallResult(
    actor: ActorLike,
    toolName: string,
    toolCallId: string,
    result: string,
    isError: boolean
  ): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_tool_call_result",
      tool_call: {
        tool_call_id: toolCallId,
        tool_name: toolName,
        arguments_text: "",
        protocol: "unknown",
        call_kind: "unknown",
        raw_payload_text: "",
      },
      output_text: result,
      is_error: isError,
    });
  }

  emitQuestionnaireRequest(actor: ActorLike, payload: QuestionnaireRequestPayload): void {
    this.emit(buildSemanticQuestionnaireRequest({
      questionnaireId: payload.questionnaireId,
      toolCallId: payload.toolCallId,
      title: payload.title,
      intro: payload.intro,
      questions: payload.questions,
    }, this.toBase(actor)));
  }

  emitQuestionnaireResult(actor: ActorLike, payload: QuestionnaireResultPayload): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_questionnaire_result",
      questionnaire_id: payload.questionnaireId,
      response_text: payload.rawText,
      approved: payload.status === "ok" ? inferApproved(payload.answers) : false,
    });
  }

  emitUserInput(actor: ActorLike, text: string): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_user_input",
      text,
      input_source: "tui",
    });
  }

  emitAgentTurnStart(actor: ActorLike, turn: number): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_turn_start",
      turn_label: String(turn),
    });
  }

  emitAgentTurnEnd(actor: ActorLike, reason: string): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_turn_end",
      reason,
    });
  }

  emitDetachedActorDone(
    actor: ActorLike,
    payload: {
      taskId: string;
      kind: DetachedActorKind;
      status: DetachedActorTerminalStatus;
      toolCallId?: string;
      childFiberId?: string;
      childActorKey?: string;
      childActorId?: string;
      outputText?: string;
      error?: string;
    },
  ): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_background_result",
      background_result: {
        task_id: payload.taskId,
        status: payload.status,
        result_text: payload.outputText || payload.error || "",
      },
    });
  }

  emitBackgroundTaskDone(
    actor: ActorLike,
    payload: {
      taskId: string;
      kind: DetachedActorKind;
      status: DetachedActorTerminalStatus;
      toolCallId?: string;
      childFiberId?: string;
      childActorKey?: string;
      childActorId?: string;
      outputText?: string;
      error?: string;
    },
  ): void {
    this.emitDetachedActorDone(actor, payload);
  }

  emitCoordinationEvent(
    actor: ActorLike,
    payload: { coordination: string; kind: string; requestId: string; status: string; decision?: string; from?: string },
  ): void {
    for (const event of mapRuntimeProtocolToSemanticEvents(payload, () => this.toBase(actor))) {
      this.emit(event);
    }
  }

  emitProtocolEvent(
    actor: ActorLike,
    payload: { coordination: string; kind: string; requestId: string; status: string; decision?: string; from?: string },
  ): void {
    this.emitCoordinationEvent(actor, payload);
  }

  emitAutonomousHolonClaim(actor: ActorLike, payload: AutonomousHolonClaimPayload): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_notice",
      message: `Autonomous holon claim: ${payload.taskId} -> ${payload.memberId}`,
      level: "info",
    });
  }

  emitAutonomousHolonIdleExit(actor: ActorLike, payload: AutonomousHolonIdleExitPayload): void {
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_notice",
      message: `Autonomous holon idle exit: ${payload.memberId} (${payload.idleTimeoutMs}ms)`,
      level: "info",
    });
  }

  emitThreadGoalUpdate(
    actor: ActorLike,
    payload: { action: string; goal: VmThreadGoalRecord | null; previousGoal?: VmThreadGoalRecord | null; error?: string },
  ): void {
    const goal = payload.goal;
    const parts = [`Thread goal ${payload.action}`];
    if (goal) {
      parts.push(`status=${goal.status}`);
      parts.push(`objective=${goal.objective}`);
      parts.push(`tokens=${goal.tokensUsed}${goal.tokenBudget ? `/${goal.tokenBudget}` : ""}`);
      parts.push(`time=${goal.timeUsedSeconds}s`);
    } else {
      parts.push("goal=none");
    }
    if (payload.error) parts.push(`error=${payload.error}`);
    this.emit({
      ...this.toBase(actor),
      event_type: "semantic_notice",
      message: parts.join("; "),
      level: payload.error ? "warning" : "info",
    });
  }

  private toBase(actor: ActorLike) {
    return buildRuntimeSemanticBase({
      agentKey: actor.key,
      agentActorId: actor.id,
    });
  }
}
