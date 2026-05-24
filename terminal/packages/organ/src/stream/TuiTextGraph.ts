import { AppendOnlyEventLog, createReducerProjection, type ReducerProjection } from "depa-data-graph-core";

import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";

import type { TuiActorDescriptor, TuiTextSnapshot } from "./TuiCardTypes";

type Subscription = { unsubscribe: () => void };

type ActorSnapshotState = {
  snapshot: TuiTextSnapshot;
  streamingLabel: string | null;
};

type TuiTextProjectionState = {
  snapshots: Map<string, ActorSnapshotState>;
  lastSnapshot: TuiTextSnapshot | null;
};

const INITIAL_TUI_TEXT_PROJECTION_STATE: TuiTextProjectionState = {
  snapshots: new Map<string, ActorSnapshotState>(),
  lastSnapshot: null,
};

export class TuiTextGraph {
  private readonly listeners = new Set<(snapshot: TuiTextSnapshot) => void>();
  private readonly eventLog = new AppendOnlyEventLog<SemanticEvent>();
  private readonly projection: ReducerProjection<SemanticEvent, TuiTextProjectionState>;
  private readonly projectionSubscription: { unsubscribe: () => void };
  private completed = false;

  constructor() {
    this.projection = createReducerProjection(this.eventLog, {
      initial: INITIAL_TUI_TEXT_PROJECTION_STATE,
      reducer: (state, entry) => reduceTuiTextProjectionState(state, entry.value),
    });

    this.projectionSubscription = this.projection.stream({ emitCurrent: false }).subscribe({
      next: (state) => {
        if (!state.lastSnapshot) {
          return;
        }
        for (const listener of [...this.listeners]) {
          listener(state.lastSnapshot);
        }
      },
      error: () => {},
      complete: () => {},
    });
  }

  consumeSemanticEvent(event: SemanticEvent): void {
    if (this.completed) {
      return;
    }
    this.eventLog.append(event);
  }

  onTextSnapshot(handler: (snapshot: TuiTextSnapshot) => void): Subscription {
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

  getSnapshot(actorId: string): TuiTextSnapshot | null {
    return this.projection.getState().snapshots.get(actorId)?.snapshot ?? null;
  }

  getSnapshots(): TuiTextSnapshot[] {
    return [...this.projection.getState().snapshots.values()].map((state) => state.snapshot);
  }

  dispose(): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.projectionSubscription.unsubscribe();
    this.projection.dispose();
    this.eventLog.dispose();
    this.listeners.clear();
  }
}

function reduceTuiTextProjectionState(
  state: TuiTextProjectionState,
  event: SemanticEvent,
): TuiTextProjectionState {
  const actor = buildActorDescriptor(event.actor);
  const actorId = actor.actor_id;
  const current = state.snapshots.get(actorId) ?? {
    snapshot: {
      actor,
      text: "",
      is_streaming: false,
    },
    streamingLabel: null,
  };

  const nextActorState = reduceSemanticEvent(current, actor, event);
  const nextSnapshots = new Map(state.snapshots);
  nextSnapshots.set(actorId, nextActorState);

  return {
    snapshots: nextSnapshots,
    lastSnapshot: nextActorState.snapshot,
  };
}

function reduceSemanticEvent(
  state: ActorSnapshotState,
  actor: TuiActorDescriptor,
  event: SemanticEvent,
): ActorSnapshotState {
  let text = state.snapshot.text;
  let isStreaming = state.snapshot.is_streaming;
  let streamingLabel = state.streamingLabel;

  const appendBlock = (label: string, body: string) => {
    if (!body) {
      return;
    }
    const prefix = text ? "\n\n" : "";
    text = `${text}${prefix}[${label}]\n${body}`;
  };

  switch (event.event_type) {
    case "semantic_user_input":
      appendBlock("USER", event.text);
      break;
    case "semantic_content_start":
      isStreaming = true;
      streamingLabel = "ASSISTANT";
      text = text ? `${text}\n\n[ASSISTANT]\n` : "[ASSISTANT]\n";
      break;
    case "semantic_content_delta":
      if (!streamingLabel) {
        isStreaming = true;
        streamingLabel = "ASSISTANT";
        text = text ? `${text}\n\n[ASSISTANT]\n` : "[ASSISTANT]\n";
      }
      text += event.text;
      break;
    case "semantic_content_end":
      isStreaming = false;
      streamingLabel = null;
      break;
    case "semantic_tool_call_result":
      appendBlock(`TOOL ${event.tool_call.tool_name}`, event.output_text);
      break;
    case "semantic_tool_call_planned":
      appendBlock("NOTICE", `Planned tool call: ${event.tool_call.tool_name} [${event.tool_call.tool_call_id}]`);
      break;
    case "semantic_tool_call_start":
      appendBlock("NOTICE", `Running tool call: ${event.tool_call.tool_name} [${event.tool_call.tool_call_id}]`);
      break;
    case "semantic_think_delta":
      appendBlock("NOTICE", `[think] ${event.text}`);
      break;
    case "semantic_quote":
      appendBlock("ASSISTANT", `[quote:${event.source}] ${event.text}`);
      break;
    case "semantic_notice":
      appendBlock("NOTICE", event.message);
      break;
    case "semantic_error":
      appendBlock("ERROR", event.error.message || event.error.detail_text);
      break;
    case "semantic_mailbox_message":
      appendBlock("INBOX", renderMailboxMessage(event.message));
      break;
    case "semantic_inbox_snapshot":
      appendBlock("INBOX", renderInboxSnapshot(event.inbox.messages, event.inbox.payload_text));
      break;
    case "semantic_task_state":
      appendBlock("NOTICE", renderTaskState(event.task.task_id, event.task.subject, event.transition));
      break;
    case "semantic_task_board":
      appendBlock("TASKS", renderTaskBoard(event.board.board_text, event.board.tasks));
      break;
    case "semantic_questionnaire_request":
      appendBlock("NOTICE", renderQuestionnaireRequest(event));
      break;
    case "semantic_questionnaire_result":
      appendBlock("NOTICE", renderQuestionnaireResult(event.questionnaire_id, event.response_text, event.approved));
      break;
    case "semantic_plan_approval_request":
      appendBlock("PLAN REVIEW", `from=${actor.title}\n${event.plan_text}`);
      break;
    case "semantic_plan_approval_result":
      appendBlock("PLAN RESPONSE", `${event.approved ? "approved" : "rejected"}\n${event.feedback_text}`);
      break;
    case "semantic_shutdown_request":
      appendBlock("SHUTDOWN REQUEST", `from=${actor.title}\ntarget=${event.target_name}\n\n${event.reason_text}`);
      break;
    case "semantic_shutdown_result":
      appendBlock("SHUTDOWN RESPONSE", `${event.approved ? "approved" : "rejected"}\ntarget=${event.target_name}\n\n${event.reason_text}`);
      break;
    case "semantic_background_result":
      appendBlock("BACKGROUND", `${event.background_result.task_id} (${event.background_result.status})\n${event.background_result.result_text}`);
      break;
    case "semantic_team_status":
      appendBlock("TEAM", renderTeamStatus(event.team_status.summary_text, event.team_status.members));
      break;
    case "semantic_actor_spawned":
      appendBlock("NOTICE", renderActorSpawned(event.actor.actor_name, event.actor.actor_kind, event.spawn_reason));
      break;
    case "semantic_actor_state":
      appendBlock("NOTICE", renderActorState(event.actor.actor_name, event.state, event.reason));
      break;
    case "semantic_turn_start":
      appendBlock("STATUS", `Turn start: ${event.turn_label || actor.title}`);
      break;
    case "semantic_turn_end":
      appendBlock("STATUS", `Turn end: ${event.reason || "completed"}`);
      break;
    default:
      break;
  }

  return {
    snapshot: {
      actor,
      text,
      is_streaming: isStreaming,
    },
    streamingLabel,
  };
}

function buildActorDescriptor(actor: SemanticEvent["actor"]): TuiActorDescriptor {
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

function renderQuestionnaireRequest(event: Extract<SemanticEvent, { event_type: "semantic_questionnaire_request" }>): string {
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
