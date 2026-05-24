export type ActorProjectionKind = string;

export type TraceSurface =
  | "tui"
  | "web"
  | "api"
  | "background"
  | "worker"
  | "unknown";

export type AgentManifestType = "main" | "subagent" | "unknown";

export type ToolCallProtocol =
  | "openai"
  | "anthropic"
  | "xml"
  | "manifest"
  | "builtin"
  | "unknown";

export type ToolCallKind =
  | "json_function"
  | "xml_tag"
  | "component"
  | "manifest"
  | "builtin"
  | "unknown";

export type QuestionnaireInputKind = "text" | "choice" | "approval";

export type TaskStatus =
  | "pending"
  | "claimed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "failed";

export type TraceData = {
  event_id: string;
  actor_id: string;
  session_id: string;
  request_id: string;
  conversation_id: string;
  stream_id: string;
  parent_event_id: string;
  causation_event_id: string;
  correlation_id: string;
  turn_id: string;
  turn_index: number;
  sequence: number;
  emitted_at: number;
  surface: TraceSurface;
};

export type ActorProjectionData = {
  actor_view_id: string;
  title: string;
  kind: ActorProjectionKind;
};

export type ActorRefData = {
  actor_id: string;
  actor_name: string;
  actor_kind: string;
  agent_definition_name: string | null;
  agent_manifest_type: AgentManifestType;
  role_label: string | null;
  actor_projection: ActorProjectionData | null;
  parent_actor_id: string | null;
  root_actor_id: string | null;
};

export type TeamRefData = {
  team_id: string;
  team_name: string;
  coordinator_actor_id: string;
  teammate_name: string;
  teammate_role: string;
  task_id: string;
};

export type UsageData = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  is_estimated: boolean;
};

export type ErrorData = {
  code: string;
  message: string;
  retryable: boolean;
  provider_status: number;
  detail_text: string;
};

export type ToolCallFunctionDeltaData = {
  name_fragment: string;
  arguments_fragment: string;
};

export type ToolCallDeltaData = {
  provider_call_index: number;
  provider_call_id: string;
  provider_call_type: string;
  function: ToolCallFunctionDeltaData | null;
};

export type ToolCallData = {
  tool_call_id: string;
  tool_name: string;
  arguments_text: string;
  protocol: ToolCallProtocol;
  call_kind: ToolCallKind;
  raw_payload_text: string;
};

export type StructuredNodeAttributeData = {
  name: string;
  value: string;
};

export type StructuredNodeData = {
  tag: string;
  text: string;
  attributes: StructuredNodeAttributeData[];
};

export type ChoiceOptionData = {
  option_id: string;
  label: string;
  value_text: string;
  description: string;
};

export type QuestionnaireStructuredQuestionData = {
  question_id: string;
  prompt: string;
  question_type: string;
  required: boolean;
  help_text: string;
  options: ChoiceOptionData[];
};

export type QuestionnaireRequestData = {
  questionnaire_id: string;
  question: string;
  input_kind: QuestionnaireInputKind;
  options: ChoiceOptionData[];
  payload_text: string;
  title_text?: string;
  intro_text?: string;
  response_protocol?: string;
  questions?: QuestionnaireStructuredQuestionData[];
};

export type MailboxTransport = "inbox" | "event_bus" | "task_board" | "system";

export type MailboxMessageData = {
  message_id: string;
  sender_name: string;
  recipient_name: string;
  message_type: string;
  subject: string;
  body_text: string;
  transport: MailboxTransport;
  requires_ack: boolean;
};

export type BackgroundResultData = {
  task_id: string;
  status: string;
  result_text: string;
};

export type TaskRefData = {
  task_id: string;
  subject: string;
  description: string;
  owner_name: string;
  status: TaskStatus;
};

export type TaskBoardData = {
  tasks: TaskRefData[];
  board_text: string;
};

export type InboxSnapshotData = {
  messages: MailboxMessageData[];
  payload_text: string;
};

export type TeamMemberStatusData = {
  member_name: string;
  role_label: string;
  state: string;
};

export type TeamStatusData = {
  team_name: string;
  members: TeamMemberStatusData[];
  summary_text: string;
};
