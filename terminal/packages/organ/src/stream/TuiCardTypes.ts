export type TuiActorDisplayKind = "primary" | "subagent" | "teammate";

export type TuiActorDescriptor = {
  actor_id: string;
  title: string;
  kind: TuiActorDisplayKind;
  created_at?: number | null;
  completed?: boolean | null;
};

export type TuiUserPromptEvent = {
  event_type: "user_prompt";
  prompt: string;
};

export type TuiAssistantStreamStartEvent = {
  event_type: "assistant_stream_start";
};

export type TuiAssistantStreamChunkEvent = {
  event_type: "assistant_stream_chunk";
  chunk: string;
};

export type TuiAssistantStreamEndEvent = {
  event_type: "assistant_stream_end";
};

export type TuiAssistantMessageEvent = {
  event_type: "assistant_message";
  message: string;
};

export type TuiToolResultEvent = {
  event_type: "tool_result";
  tool_name: string;
  output: string;
};

export type TuiTaskBoardEvent = {
  event_type: "task_board";
  board: string;
};

export type TuiShutdownRequestEvent = {
  event_type: "shutdown_request";
  request_id: string;
  sender: string;
  message: string;
};

export type TuiShutdownResponseEvent = {
  event_type: "shutdown_response";
  request_id: string;
  approved: boolean;
  reason: string;
};

export type TuiPlanApprovalRequestEvent = {
  event_type: "plan_approval_request";
  request_id: string;
  sender: string;
  plan: string;
};

export type TuiPlanApprovalResponseEvent = {
  event_type: "plan_approval_response";
  request_id: string;
  approved: boolean;
  feedback: string;
};

export type TuiTeamStatusEvent = {
  event_type: "team_status";
  team: string;
};

export type TuiInboxEvent = {
  event_type: "inbox";
  payload: string;
};

export type TuiBackgroundResultEvent = {
  event_type: "background_result";
  task_id: string;
  status: string;
  result: string;
};

export type TuiNoticeEvent = {
  event_type: "notice";
  message: string;
  level?: "info" | "warning";
};

export type TuiErrorEvent = {
  event_type: "error";
  message: string;
};

export type TuiStatusEvent = {
  event_type: "status";
  message: string;
};

export type TuiCardUiEvent =
  | TuiUserPromptEvent
  | TuiAssistantStreamStartEvent
  | TuiAssistantStreamChunkEvent
  | TuiAssistantStreamEndEvent
  | TuiAssistantMessageEvent
  | TuiToolResultEvent
  | TuiTaskBoardEvent
  | TuiShutdownRequestEvent
  | TuiShutdownResponseEvent
  | TuiPlanApprovalRequestEvent
  | TuiPlanApprovalResponseEvent
  | TuiTeamStatusEvent
  | TuiInboxEvent
  | TuiBackgroundResultEvent
  | TuiNoticeEvent
  | TuiErrorEvent
  | TuiStatusEvent;

export type TuiActorEvent = {
  actor: TuiActorDescriptor;
  event: TuiCardUiEvent;
};

export type TuiTextSnapshot = {
  actor: TuiActorDescriptor;
  text: string;
  is_streaming: boolean;
};

