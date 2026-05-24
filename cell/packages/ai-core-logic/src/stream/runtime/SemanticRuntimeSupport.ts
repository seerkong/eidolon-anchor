import type { QuestionnaireQuestion } from "@cell/ai-core-contract/runtime/Questionnaire";
import {
  asQuestionnaireProtocolSourceQuestions,
  buildQuestionnaireReplyHint,
} from "@cell/ai-core-contract/runtime/QuestionnaireProtocol";
import type { IngressSource, JsonToolCall, ParsedXmlToolCall, ToolCallType } from "@cell/ai-core-contract/stream/ingressAdapterTypes";
import type { TraceSurface } from "@cell/ai-core-contract/stream/common";
import type {
  SemanticEvent,
  SemanticQuoteSource,
  SemanticQuestionnaireRequestEvent,
} from "@cell/ai-core-contract/stream/semantic";

export type RuntimeSemanticActorMeta = {
  agentKey: string;
  agentActorId: string;
};

export function buildRuntimeSemanticBase(
  meta: RuntimeSemanticActorMeta,
  sequence: number = Date.now(),
  surface: TraceSurface = "tui",
): {
  trace: SemanticEvent["trace"];
  actor: SemanticEvent["actor"];
  team: SemanticEvent["team"];
} {
  return {
    trace: buildRuntimeSemanticTrace(sequence, surface),
    actor: buildRuntimeSemanticActorRef(meta),
    team: buildRuntimeSemanticTeamRef(),
  };
}

export function buildRuntimeSemanticTrace(
  sequence: number,
  surface: TraceSurface = "tui",
): SemanticEvent["trace"] {
  return {
    event_id: `semantic-runtime-${sequence}`,
    actor_id: "",
    session_id: "",
    request_id: "",
    conversation_id: "",
    stream_id: "",
    parent_event_id: "",
    causation_event_id: "",
    correlation_id: "",
    turn_id: "",
    turn_index: 0,
    sequence,
    emitted_at: Date.now(),
    surface,
  };
}

export function buildRuntimeSemanticActorRef(
  meta: RuntimeSemanticActorMeta,
): SemanticEvent["actor"] {
  return {
    actor_id: meta.agentActorId,
    actor_name: meta.agentKey,
    actor_kind: meta.agentKey === "main" ? "primary" : "subagent",
    agent_definition_name: null,
    agent_manifest_type: "unknown",
    role_label: null,
    actor_projection: null,
    parent_actor_id: null,
    root_actor_id: null,
  };
}

export function buildRuntimeSemanticTeamRef(): SemanticEvent["team"] {
  return {
    team_id: "",
    team_name: "",
    coordinator_actor_id: "",
    teammate_name: "",
    teammate_role: "",
    task_id: "",
  };
}

export function toSemanticQuoteSource(source: IngressSource): SemanticQuoteSource {
  if (source === "think") return "thinking";
  if (source === "content") return "content";
  return "tool";
}

export function toSemanticToolCall(
  toolCall: ParsedXmlToolCall | JsonToolCall,
  type: ToolCallType,
) {
  if ("funcId" in toolCall) {
    return {
      tool_call_id: toolCall.id,
      tool_name: toolCall.funcId,
      arguments_text: toolCall.code,
      protocol: "xml" as const,
      call_kind: "xml_tag" as const,
      raw_payload_text: "",
    };
  }

  return {
    tool_call_id: toolCall.id,
    tool_name: toolCall.functionName,
    arguments_text: toolCall.functionArguments,
    protocol: type === "json" ? ("openai" as const) : ("unknown" as const),
    call_kind: type === "json" ? ("json_function" as const) : ("unknown" as const),
    raw_payload_text: "",
  };
}

export function buildSemanticQuestionnaireRequest(
  payload: {
    questionnaireId: string;
    toolCallId?: string | null;
    title?: string;
    intro?: string;
    questions: QuestionnaireQuestion[];
  },
  base: {
    trace: SemanticEvent["trace"];
    actor: SemanticEvent["actor"];
    team: SemanticEvent["team"];
  },
): SemanticQuestionnaireRequestEvent {
  return {
    ...base,
    event_type: "semantic_questionnaire_request",
    questionnaire_request: {
      questionnaire_id: payload.questionnaireId,
      question: payload.title || payload.intro || firstQuestionPrompt(payload.questions),
      input_kind: toSemanticInputKind(payload.questions),
      options: toSemanticChoiceOptions(payload.questions),
      payload_text: payload.intro || "",
      title_text: payload.title,
      intro_text: payload.intro,
      response_protocol: "ask-multi-question-free",
      questions: payload.questions.map((question) => ({
        question_id: question.id,
        prompt: question.prompt,
        question_type: question.type,
        required: question.required === true,
        help_text: question.helpText || "",
        options: (question.choices ?? []).map((choice, index) => {
          if (typeof choice === "string") {
            return {
              option_id: `${index + 1}`,
              label: choice,
              value_text: choice,
              description: "",
            };
          }
          return {
            option_id: choice.value,
            label: choice.label || choice.value,
            value_text: choice.value,
            description: "",
          };
        }),
      })),
    },
    tool_call: payload.toolCallId
      ? {
          tool_call_id: payload.toolCallId,
          tool_name: "questionnaire",
          arguments_text: "",
          protocol: "unknown",
          call_kind: "unknown",
          raw_payload_text: "",
        }
      : null,
  };
}

export function mapRuntimeProtocolToSemanticEvents(
  payload: {
    coordination: string;
    kind: string;
    requestId: string;
    status: string;
    decision?: string;
    from?: string;
  },
  build: () => {
    trace: SemanticEvent["trace"];
    actor: SemanticEvent["actor"];
    team: SemanticEvent["team"];
  },
): SemanticEvent[] {
  if (payload.coordination === "plan_approval") {
    if (payload.kind === "plan_approval_request" || payload.kind === "plan_request") {
      return [{
        ...build(),
        event_type: "semantic_plan_approval_request",
        request_id: payload.requestId,
        plan_text: payload.status || "",
      }];
    }
    if (payload.kind === "plan_approval_result" || payload.kind === "plan_review") {
      return [{
        ...build(),
        event_type: "semantic_plan_approval_result",
        request_id: payload.requestId,
        approved: payload.decision === "approved",
        feedback_text: payload.status || "",
      }];
    }
  }

  if (payload.coordination === "shutdown") {
    if (payload.kind === "shutdown_request") {
      return [{
        ...build(),
        event_type: "semantic_shutdown_request",
        request_id: payload.requestId,
        target_name: payload.from || "",
        reason_text: payload.status || "",
      }];
    }
    if (payload.kind === "shutdown_response") {
      return [{
        ...build(),
        event_type: "semantic_shutdown_result",
        request_id: payload.requestId,
        target_name: payload.from || "",
        approved: payload.decision === "approved",
        reason_text: payload.status || "",
      }];
    }
  }

  return [{
    ...build(),
    event_type: "semantic_notice",
    message: `${payload.coordination}:${payload.kind}:${payload.status}`,
    level: "info",
  }];
}

export function inferApproved(answers: Record<string, unknown>): boolean | null {
  const firstValue = Object.values(answers)[0];
  if (typeof firstValue === "boolean") return firstValue;
  if (typeof firstValue === "string") {
    const normalized = firstValue.trim().toLowerCase();
    if (["yes", "y", "approve", "approved", "true"].includes(normalized)) return true;
    if (["no", "n", "reject", "rejected", "false"].includes(normalized)) return false;
  }
  return null;
}

function firstQuestionPrompt(questions: QuestionnaireQuestion[]): string {
  return questions[0]?.prompt || "Questionnaire";
}

function toSemanticInputKind(questions: QuestionnaireQuestion[]): "text" | "choice" | "approval" {
  const first = questions[0];
  if (!first) return "approval";
  if (first.type === "yes_no") return "approval";
  if (first.type === "single_select" || first.type === "multi_select") return "choice";
  return "text";
}

function toSemanticChoiceOptions(questions: QuestionnaireQuestion[]) {
  const first = questions[0];
  if (!first?.choices) return [];
  return first.choices.map((choice, index) => {
    if (typeof choice === "string") {
      return {
        option_id: `${index + 1}`,
        label: choice,
        value_text: choice,
        description: "",
      };
    }
    return {
      option_id: choice.value,
      label: choice.label || choice.value,
      value_text: choice.value,
      description: "",
    };
  });
}
