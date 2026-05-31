import type {
  SemanticBackgroundResultEvent,
  SemanticEvent,
  SemanticQuestionnaireRequestEvent,
} from "@cell/ai-core-contract/stream/semantic";

import type {
  TuiActorDescriptor,
  TuiActorEvent,
  TuiBackgroundResultEvent,
  TuiCardUiEvent,
  TuiInboxEvent,
  TuiNoticeEvent,
} from "./TuiCardTypes";

type Subscription = { unsubscribe: () => void };

const MAX_TUI_CARD_EVENTS = 1_000;

export class TuiCardGraph {
  private readonly listeners = new Set<(event: TuiActorEvent) => void>();
  private readonly events: TuiActorEvent[] = [];
  private completed = false;

  consumeSemanticEvent(event: SemanticEvent): void {
    if (this.completed) {
      return;
    }
    for (const actorEvent of mapSemanticEventToCardEvents(event)) {
      this.events.push(actorEvent);
      if (this.events.length > MAX_TUI_CARD_EVENTS) {
        this.events.splice(0, this.events.length - MAX_TUI_CARD_EVENTS);
      }
      for (const listener of [...this.listeners]) {
        listener(actorEvent);
      }
    }
  }

  getEvents(): TuiActorEvent[] {
    return [...this.events];
  }

  onCardEvent(handler: (event: TuiActorEvent) => void): Subscription {
    if (this.completed) {
      return { unsubscribe: () => {} };
    }
    this.listeners.add(handler);
    return {
      unsubscribe: () => {
        this.listeners.delete(handler);
      },
    };
  }

  dispose(): void {
    this.completed = true;
    this.listeners.clear();
    this.events.length = 0;
  }
}

export function mapSemanticEventToCardEvents(event: SemanticEvent): TuiActorEvent[] {
  const actor = buildActorDescriptor(event.actor);

  switch (event.event_type) {
    case "semantic_user_input":
      return [{ actor, event: { event_type: "user_prompt", prompt: event.text } }];
    case "semantic_content_start":
      return [{ actor, event: { event_type: "assistant_stream_start" } }];
    case "semantic_content_delta":
      return [{ actor, event: { event_type: "assistant_stream_chunk", chunk: event.text } }];
    case "semantic_content_end":
      return [{ actor, event: { event_type: "assistant_stream_end" } }];
    case "semantic_tool_call_result":
      return [{
        actor,
        event: {
          event_type: "tool_result",
          tool_name: event.tool_call.tool_name,
          output: event.output_text,
        },
      }];
    case "semantic_tool_call_planned":
      return [noticeEvent(actor, `Planned tool call: ${event.tool_call.tool_name} [${event.tool_call.tool_call_id}]`)];
    case "semantic_tool_call_start":
      return [noticeEvent(actor, `Running tool call: ${event.tool_call.tool_name} [${event.tool_call.tool_call_id}]`)];
    case "semantic_think_delta":
      return [noticeEvent(actor, `[think] ${event.text}`)];
    case "semantic_quote":
      return [{
        actor,
        event: {
          event_type: "assistant_message",
          message: `[quote:${event.source}] ${event.text}`,
        },
      }];
    case "semantic_notice":
      return [noticeEvent(actor, event.message, event.level)];
    case "semantic_error":
      return [{
        actor,
        event: {
          event_type: "error",
          message: event.error.message || event.error.detail_text,
        },
      }];
    case "semantic_mailbox_message":
      return [{
        actor,
        event: {
          event_type: "inbox",
          payload: renderMailboxMessage(event.message),
        } satisfies TuiInboxEvent,
      }];
    case "semantic_inbox_snapshot":
      return [{
        actor,
        event: {
          event_type: "inbox",
          payload: renderInboxSnapshot(event.inbox.messages, event.inbox.payload_text),
        } satisfies TuiInboxEvent,
      }];
    case "semantic_task_state":
      return [noticeEvent(actor, renderTaskState(event.task.task_id, event.task.subject, event.transition))];
    case "semantic_task_board":
      return [{
        actor,
        event: {
          event_type: "task_board",
          board: renderTaskBoard(event.board.board_text, event.board.tasks),
        },
      }];
    case "semantic_questionnaire_request":
      return [noticeEvent(actor, renderQuestionnaireRequest(event))];
    case "semantic_questionnaire_result":
      return [noticeEvent(actor, renderQuestionnaireResult(event.questionnaire_id, event.response_text, event.approved))];
    case "semantic_plan_approval_request":
      return [{
        actor,
        event: {
          event_type: "plan_approval_request",
          request_id: event.request_id,
          sender: actor.title,
          plan: event.plan_text,
        },
      }];
    case "semantic_plan_approval_result":
      return [{
        actor,
        event: {
          event_type: "plan_approval_response",
          request_id: event.request_id,
          approved: event.approved,
          feedback: event.feedback_text,
        },
      }];
    case "semantic_shutdown_request":
      return [{
        actor,
        event: {
          event_type: "shutdown_request",
          request_id: event.request_id,
          sender: actor.title,
          message: `target=${event.target_name}\n\n${event.reason_text}`,
        },
      }];
    case "semantic_shutdown_result":
      return [{
        actor,
        event: {
          event_type: "shutdown_response",
          request_id: event.request_id,
          approved: event.approved,
          reason: `target=${event.target_name}\n\n${event.reason_text}`,
        },
      }];
    case "semantic_background_result":
      return [{
        actor,
        event: backgroundResultEvent(event),
      }];
    case "semantic_team_status":
      return [{
        actor,
        event: {
          event_type: "team_status",
          team: renderTeamStatus(event.team_status.summary_text, event.team_status.members),
        },
      }];
    case "semantic_actor_spawned":
      return [noticeEvent(actor, renderActorSpawned(event.actor.actor_name, event.actor.actor_kind, event.spawn_reason))];
    case "semantic_actor_state":
      return [noticeEvent(actor, renderActorState(event.actor.actor_name, event.state, event.reason))];
    case "semantic_turn_start":
      return [{
        actor,
        event: {
          event_type: "status",
          message: `Turn start: ${event.turn_label || actor.title}`,
        },
      }];
    case "semantic_turn_end":
      return [{
        actor,
        event: {
          event_type: "status",
          message: `Turn end: ${event.reason || "completed"}`,
        },
      }];
    default:
      return [];
  }
}

type SemanticActorRefData = SemanticEvent["actor"];

function buildActorDescriptor(actor: SemanticActorRefData): TuiActorDescriptor {
  if (actor.actor_projection) {
    return {
      actor_id: actor.actor_projection.actor_view_id,
      title: actor.actor_projection.title,
      kind: normalizeActorKind(actor.actor_projection.kind),
    };
  }

  return {
    actor_id: actor.actor_id || "primary",
    title: actor.actor_name || "Primary",
    kind: normalizeActorKind(actor.actor_kind),
  };
}

function normalizeActorKind(kind: string): TuiActorDescriptor["kind"] {
  if (kind === "subagent" || kind === "teammate" || kind === "primary") {
    return kind;
  }
  return "primary";
}

function noticeEvent(actor: TuiActorDescriptor, message: string, level: "info" | "warning" = "info"): TuiActorEvent {
  return {
    actor,
    event: {
      event_type: "notice",
      message,
      level,
    } satisfies TuiNoticeEvent,
  };
}

function backgroundResultEvent(event: SemanticBackgroundResultEvent): TuiBackgroundResultEvent {
  return {
    event_type: "background_result",
    task_id: event.background_result.task_id,
    status: event.background_result.status,
    result: event.background_result.result_text,
  };
}

function renderMailboxMessage(message: SemanticEvent["event_type"] extends never ? never : any): string {
  const subject = message.subject ? `\nsubject=${message.subject}` : "";
  return `from=${message.sender_name}\nto=${message.recipient_name}\ntype=${message.message_type}${subject}\n\n${message.body_text}`;
}

function renderInboxSnapshot(messages: Array<any>, payloadText: string): string {
  if (payloadText.trim()) {
    return payloadText;
  }
  return messages.map(renderMailboxMessage).join("\n\n");
}

function renderTaskState(taskId: string, subject: string, transition: string): string {
  return `Task ${transition}: ${taskId} - ${subject}`;
}

function renderTaskBoard(boardText: string, tasks: Array<any>): string {
  if (boardText.trim()) {
    return boardText;
  }
  return tasks.map((task) => String(task)).join("\n");
}

function renderQuestionnaireRequest(event: SemanticQuestionnaireRequestEvent): string {
  return `Questionnaire requested [${event.questionnaire_request.questionnaire_id}]: ${event.questionnaire_request.question}`;
}

function renderQuestionnaireResult(questionnaireId: string, responseText: string, approved: boolean | null): string {
  const decision = approved ? "approved" : "rejected";
  return `Questionnaire result [${questionnaireId}]: ${decision} - ${responseText}`;
}

function renderTeamStatus(summaryText: string, members: Array<any>): string {
  if (summaryText.trim()) {
    return summaryText;
  }
  return members.map((member) => String(member)).join("\n");
}

function renderActorSpawned(actorName: string, actorKind: string, spawnReason: string): string {
  return spawnReason
    ? `Actor spawned: ${actorName} (${actorKind}) - ${spawnReason}`
    : `Actor spawned: ${actorName} (${actorKind})`;
}

function renderActorState(actorName: string, state: string, reason: string): string {
  return reason
    ? `Actor state: ${actorName} -> ${state} (${reason})`
    : `Actor state: ${actorName} -> ${state}`;
}
