import type {
  ActorRefData,
  BackgroundResultData,
  ErrorData,
  InboxSnapshotData,
  MailboxMessageData,
  QuestionnaireRequestData,
  TaskBoardData,
  TaskRefData,
  TeamRefData,
  TeamStatusData,
  ToolCallData,
  TraceData,
} from "./common";

export const SEMANTIC_EVENT_TYPES = [
  "semantic_user_input",
  "semantic_turn_start",
  "semantic_turn_end",
  "semantic_think_start",
  "semantic_think_delta",
  "semantic_think_end",
  "semantic_content_start",
  "semantic_content_delta",
  "semantic_content_end",
  "semantic_quote",
  "semantic_tool_call_planned",
  "semantic_tool_call_start",
  "semantic_tool_call_result",
  "semantic_questionnaire_request",
  "semantic_questionnaire_result",
  "semantic_actor_spawned",
  "semantic_actor_state",
  "semantic_mailbox_message",
  "semantic_inbox_snapshot",
  "semantic_task_state",
  "semantic_task_board",
  "semantic_plan_approval_request",
  "semantic_plan_approval_result",
  "semantic_shutdown_request",
  "semantic_shutdown_result",
  "semantic_background_result",
  "semantic_team_status",
  "semantic_notice",
  "semantic_error",
] as const;

export type SemanticEventType = (typeof SEMANTIC_EVENT_TYPES)[number];

export type SemanticInputSource = "tui" | "web" | "api" | "questionnaire" | "system";
export type SemanticQuoteSource = "thinking" | "content" | "tool";
export type SemanticActorStateValue =
  | "created"
  | "running"
  | "idle"
  | "waiting"
  | "working"
  | "completed"
  | "failed"
  | "shutdown"
  | "cancelled";
export type SemanticMailboxDirection = "inbound" | "outbound" | "broadcast";
export type SemanticTaskTransition =
  | "created"
  | "claimed"
  | "started"
  | "completed"
  | "cancelled"
  | "failed";
export type SemanticNoticeLevel = "info" | "warning";

type SemanticEventBase<TEventType extends SemanticEventType> = {
  trace: TraceData;
  actor: ActorRefData;
  team: TeamRefData;
  event_type: TEventType;
};

export type SemanticUserInputEvent = SemanticEventBase<"semantic_user_input"> & {
  text: string;
  input_source: SemanticInputSource;
};

export type SemanticTurnStartEvent = SemanticEventBase<"semantic_turn_start"> & {
  turn_label: string;
};

export type SemanticTurnEndEvent = SemanticEventBase<"semantic_turn_end"> & {
  reason: string;
};

export type SemanticThinkStartEvent = SemanticEventBase<"semantic_think_start">;

export type SemanticThinkDeltaEvent = SemanticEventBase<"semantic_think_delta"> & {
  text: string;
};

export type SemanticThinkEndEvent = SemanticEventBase<"semantic_think_end">;

export type SemanticContentStartEvent = SemanticEventBase<"semantic_content_start">;

export type SemanticContentDeltaEvent = SemanticEventBase<"semantic_content_delta"> & {
  text: string;
};

export type SemanticContentEndEvent = SemanticEventBase<"semantic_content_end">;

export type SemanticQuoteEvent = SemanticEventBase<"semantic_quote"> & {
  source: SemanticQuoteSource;
  text: string;
};

export type SemanticToolCallPlannedEvent =
  SemanticEventBase<"semantic_tool_call_planned"> & {
    tool_call: ToolCallData;
  };

export type SemanticToolCallStartEvent = SemanticEventBase<"semantic_tool_call_start"> & {
  tool_call: ToolCallData;
};

export type SemanticToolCallResultEvent =
  SemanticEventBase<"semantic_tool_call_result"> & {
    tool_call: ToolCallData;
    output_text: string;
    is_error: boolean;
  };

export type SemanticQuestionnaireRequestEvent =
  SemanticEventBase<"semantic_questionnaire_request"> & {
    questionnaire_request: QuestionnaireRequestData;
    tool_call: ToolCallData | null;
  };

export type SemanticQuestionnaireResultEvent =
  SemanticEventBase<"semantic_questionnaire_result"> & {
    questionnaire_id: string;
    response_text: string;
    approved: boolean | null;
  };

export type SemanticActorSpawnedEvent = SemanticEventBase<"semantic_actor_spawned"> & {
  parent_actor: ActorRefData | null;
  spawn_reason: string;
};

export type SemanticActorStateEvent = SemanticEventBase<"semantic_actor_state"> & {
  state: SemanticActorStateValue;
  reason: string;
};

export type SemanticMailboxMessageEvent =
  SemanticEventBase<"semantic_mailbox_message"> & {
    message: MailboxMessageData;
    direction: SemanticMailboxDirection;
  };

export type SemanticInboxSnapshotEvent =
  SemanticEventBase<"semantic_inbox_snapshot"> & {
    inbox: InboxSnapshotData;
  };

export type SemanticTaskStateEvent = SemanticEventBase<"semantic_task_state"> & {
  task: TaskRefData;
  transition: SemanticTaskTransition;
};

export type SemanticTaskBoardEvent = SemanticEventBase<"semantic_task_board"> & {
  board: TaskBoardData;
};

export type SemanticPlanApprovalRequestEvent =
  SemanticEventBase<"semantic_plan_approval_request"> & {
    request_id: string;
    plan_text: string;
  };

export type SemanticPlanApprovalResultEvent =
  SemanticEventBase<"semantic_plan_approval_result"> & {
    request_id: string;
    approved: boolean;
    feedback_text: string;
  };

export type SemanticShutdownRequestEvent =
  SemanticEventBase<"semantic_shutdown_request"> & {
    request_id: string;
    target_name: string;
    reason_text: string;
  };

export type SemanticShutdownResultEvent =
  SemanticEventBase<"semantic_shutdown_result"> & {
    request_id: string;
    target_name: string;
    approved: boolean;
    reason_text: string;
  };

export type SemanticBackgroundResultEvent =
  SemanticEventBase<"semantic_background_result"> & {
    background_result: BackgroundResultData;
  };

export type SemanticTeamStatusEvent = SemanticEventBase<"semantic_team_status"> & {
  team_status: TeamStatusData;
};

export type SemanticNoticeEvent = SemanticEventBase<"semantic_notice"> & {
  message: string;
  level: SemanticNoticeLevel;
};

export type SemanticErrorEvent = SemanticEventBase<"semantic_error"> & {
  error: ErrorData;
};

export type SemanticThinkingEvents =
  | SemanticThinkStartEvent
  | SemanticThinkDeltaEvent
  | SemanticThinkEndEvent;

export type SemanticContentEvents =
  | SemanticContentStartEvent
  | SemanticContentDeltaEvent
  | SemanticContentEndEvent;

export type SemanticEvent =
  | SemanticUserInputEvent
  | SemanticTurnStartEvent
  | SemanticTurnEndEvent
  | SemanticThinkStartEvent
  | SemanticThinkDeltaEvent
  | SemanticThinkEndEvent
  | SemanticContentStartEvent
  | SemanticContentDeltaEvent
  | SemanticContentEndEvent
  | SemanticQuoteEvent
  | SemanticToolCallPlannedEvent
  | SemanticToolCallStartEvent
  | SemanticToolCallResultEvent
  | SemanticQuestionnaireRequestEvent
  | SemanticQuestionnaireResultEvent
  | SemanticActorSpawnedEvent
  | SemanticActorStateEvent
  | SemanticMailboxMessageEvent
  | SemanticInboxSnapshotEvent
  | SemanticTaskStateEvent
  | SemanticTaskBoardEvent
  | SemanticPlanApprovalRequestEvent
  | SemanticPlanApprovalResultEvent
  | SemanticShutdownRequestEvent
  | SemanticShutdownResultEvent
  | SemanticBackgroundResultEvent
  | SemanticTeamStatusEvent
  | SemanticNoticeEvent
  | SemanticErrorEvent;
