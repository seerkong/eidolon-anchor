import type { SemanticEvent, SemanticQuestionnaireRequestEvent } from "@cell/ai-core-contract/stream/semantic";
import type { TuiControl, TuiEvent, TuiMessageCategory } from "@terminal/core/AIAgent/TuiStreamEvents";
import { formatQuestionnaireRequestText } from "./questionnairePresentation";

type Subscription = { unsubscribe: () => void };

const PREFIX = {
  think: "🤔 Think: ",
  assist: "🤖 Assist: ",
  toolcall: "🔧 ToolCall: ",
  result: "✅ Result: ",
  questionnaire: "❓ Questionnaire: ",
  quote: "🛐 Quote: ",
  turn: "🚀 Turn: ",
  done: "🏁 Done: ",
  notice: "ℹ️ Notice: ",
  error: "⛔ Error: ",
} as const;

export class TextualProjectionGraph {
  private current: TuiMessageCategory | null = null;
  private firstInSegment = false;
  private completed = false;
  private readonly eventListeners = new Set<(event: TuiEvent) => void>();
  private readonly messageListeners = new Set<(message: string) => void>();
  private readonly controlListeners = new Set<(control: TuiControl) => void>();

  consumeSemanticEvent(event: SemanticEvent): void {
    if (this.completed) {
      return;
    }

    switch (event.event_type) {
      case "semantic_think_start":
        this.ensureSegment("think");
        break;
      case "semantic_think_delta":
        this.ensureSegment("think");
        this.emitMessage(this.firstInSegment ? `${PREFIX.think}${event.text}` : event.text);
        this.firstInSegment = false;
        break;
      case "semantic_think_end":
        this.resetSegment();
        break;
      case "semantic_content_start":
        this.ensureSegment("assist");
        break;
      case "semantic_content_delta":
        this.ensureSegment("assist");
        this.emitMessage(this.firstInSegment ? `${PREFIX.assist}${event.text}` : event.text);
        this.firstInSegment = false;
        break;
      case "semantic_content_end":
        this.resetSegment();
        break;
      case "semantic_quote":
        this.ensureSegment("quote");
        this.emitMessage(`${PREFIX.quote}${event.text}`);
        this.resetSegment();
        break;
      case "semantic_tool_call_planned":
        this.ensureSegment("toolcall");
        this.emitMessage(`${PREFIX.toolcall}${formatToolCall(event.tool_call)}`);
        this.resetSegment();
        break;
      case "semantic_tool_call_start":
        this.ensureSegment("toolcall");
        this.emitMessage(`${PREFIX.toolcall}${formatToolCallStart(event.tool_call)}`);
        this.resetSegment();
        break;
      case "semantic_tool_call_result":
        this.ensureSegment("result");
        this.emitMessage(`${PREFIX.result}${formatToolCallResult(event.tool_call.tool_name, event.output_text)}`);
        this.resetSegment();
        break;
      case "semantic_questionnaire_request":
        this.ensureSegment("questionnaire");
        this.emitMessage(`${PREFIX.questionnaire}${formatQuestionnaire(event)}`);
        this.resetSegment();
        break;
      case "semantic_questionnaire_result":
        this.ensureSegment("questionnaire");
        this.emitMessage(`${PREFIX.questionnaire}Questionnaire ${event.questionnaire_id}: ${event.response_text}\n`);
        this.resetSegment();
        break;
      case "semantic_plan_approval_request":
        this.ensureSegment("questionnaire");
        this.emitMessage(`${PREFIX.questionnaire}Plan approval ${event.request_id}\n${event.plan_text}\n`);
        this.resetSegment();
        break;
      case "semantic_plan_approval_result":
        this.ensureSegment("result");
        this.emitMessage(`${PREFIX.result}Plan approval ${event.approved ? "approved" : "rejected"}: ${event.feedback_text}\n`);
        this.resetSegment();
        break;
      case "semantic_shutdown_request":
        this.ensureSegment("notice");
        this.emitMessage(`${PREFIX.notice}Shutdown request ${event.request_id} ${event.target_name}\n${event.reason_text}\n`);
        this.resetSegment();
        break;
      case "semantic_shutdown_result":
        this.ensureSegment("result");
        this.emitMessage(`${PREFIX.result}Shutdown ${event.approved ? "approved" : "rejected"} ${event.target_name}\n${event.reason_text}\n`);
        this.resetSegment();
        break;
      case "semantic_background_result":
        this.ensureSegment("result");
        this.emitMessage(`${PREFIX.result}${event.background_result.task_id}: ${event.background_result.result_text}\n`);
        this.resetSegment();
        break;
      case "semantic_team_status":
        this.ensureSegment("notice");
        this.emitMessage(`${PREFIX.notice}${event.team_status.summary_text}\n`);
        this.resetSegment();
        break;
      case "semantic_mailbox_message":
        this.ensureSegment("notice");
        this.emitMessage(`${PREFIX.notice}${event.message.sender_name}: ${event.message.body_text}\n`);
        this.resetSegment();
        break;
      case "semantic_inbox_snapshot":
        this.ensureSegment("notice");
        this.emitMessage(`${PREFIX.notice}${event.inbox.payload_text}\n`);
        this.resetSegment();
        break;
      case "semantic_task_state":
        this.ensureSegment("notice");
        this.emitMessage(`${PREFIX.notice}${event.task.subject}: ${event.transition}\n`);
        this.resetSegment();
        break;
      case "semantic_task_board":
        this.ensureSegment("notice");
        this.emitMessage(`${PREFIX.notice}${event.board.board_text}\n`);
        this.resetSegment();
        break;
      case "semantic_actor_spawned":
        this.ensureSegment("notice");
        this.emitMessage(`${PREFIX.notice}${event.actor.actor_name}: ${event.spawn_reason}\n`);
        this.resetSegment();
        break;
      case "semantic_actor_state":
        this.ensureSegment("notice");
        this.emitMessage(`${PREFIX.notice}${event.actor.actor_name}: ${event.state}\n`);
        this.resetSegment();
        break;
      case "semantic_turn_start":
        this.ensureSegment("turn");
        this.emitMessage(`${PREFIX.turn}Starting turn ${event.turn_label}\n`);
        this.resetSegment();
        break;
      case "semantic_turn_end":
        this.ensureSegment("done");
        this.emitMessage(`${PREFIX.done}Turn ${event.reason}\n`);
        this.resetSegment();
        break;
      case "semantic_notice":
        this.ensureSegment("notice");
        this.emitMessage(`${PREFIX.notice}${event.message}\n`);
        this.resetSegment();
        break;
      case "semantic_error":
        this.ensureSegment("error");
        this.emitMessage(`${PREFIX.error}${event.error.message || event.error.detail_text}\n`);
        this.resetSegment();
        break;
      default:
        break;
    }
  }

  onTuiEvent(handler: (event: TuiEvent) => void): Subscription {
    if (this.completed) return { unsubscribe: () => {} };
    this.eventListeners.add(handler);
    return { unsubscribe: () => this.eventListeners.delete(handler) };
  }

  onTuiMessage(handler: (message: string) => void): Subscription {
    if (this.completed) return { unsubscribe: () => {} };
    this.messageListeners.add(handler);
    return { unsubscribe: () => this.messageListeners.delete(handler) };
  }

  onTuiControl(handler: (control: TuiControl) => void): Subscription {
    if (this.completed) return { unsubscribe: () => {} };
    this.controlListeners.add(handler);
    return { unsubscribe: () => this.controlListeners.delete(handler) };
  }

  dispose(): void {
    this.completed = true;
    this.eventListeners.clear();
    this.messageListeners.clear();
    this.controlListeners.clear();
  }

  private ensureSegment(type: TuiMessageCategory): void {
    if (this.current === type) return;
    this.current = type;
    this.firstInSegment = true;
    this.emitControl({ cmd: "NewMessage", category: type });
  }

  private resetSegment(): void {
    this.current = null;
    this.firstInSegment = false;
  }

  private emitControl(payload: TuiControl): void {
    const event: TuiEvent = { kind: "control", payload };
    for (const listener of [...this.eventListeners]) listener(event);
    for (const listener of [...this.controlListeners]) listener(payload);
  }

  private emitMessage(text: string): void {
    if (!text) return;
    const event: TuiEvent = { kind: "message", payload: text };
    for (const listener of [...this.eventListeners]) listener(event);
    for (const listener of [...this.messageListeners]) listener(text);
  }
}

function formatToolCall(toolCall: { tool_name: string; arguments_text: string }): string {
  return toolCall.arguments_text
    ? `${toolCall.tool_name}\n${toolCall.arguments_text}\n`
    : `${toolCall.tool_name}\n`;
}

function formatToolCallStart(toolCall: { tool_name: string; tool_call_id: string }): string {
  const suffix = toolCall.tool_call_id ? ` [${toolCall.tool_call_id}]` : "";
  return `${toolCall.tool_name}${suffix}\n`;
}

function formatToolCallResult(toolName: string, outputText: string): string {
  const preview = outputText.length > 100 ? `${outputText.slice(0, 100)}...` : outputText;
  return `${toolName}: ${preview}\n`;
}

function formatQuestionnaire(event: SemanticQuestionnaireRequestEvent): string {
  return `${formatQuestionnaireRequestText(event.questionnaire_request)}\n`;
}
