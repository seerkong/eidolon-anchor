import type { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";

/**
 * P8 single-writer pipeline (decisions.md decision 8) test support.
 *
 * In production, the LLM ingress pipeline emits the full semantic event
 * sequence onto `vm.eventBus` as the assistant turn streams; the resident
 * MessageHistoryGraph consumes those events and commits a ChatMessage into
 * the History domain. Unit tests typically stub `processStream` with a mock
 * that just returns a finished assistant msg — that bypasses the bus and
 * leaves the graph with nothing to commit, which the executor (intentionally)
 * surfaces by writing an empty conversation projection.
 *
 * `createMockProcessStream(impl)` wraps a user-supplied mock so the returned
 * msg is replayed as a semantic envelope onto the bus:
 *   - reasoning_content (if any) → think_start / think_delta / think_end
 *   - content → content_start / content_delta / content_end
 *   - tool_calls (function-call shape) → one tool_call_planned per call
 *   - turn_end (only when there are no tool calls — when tool calls are
 *     present the next tool_call_result emit flushes the assistant)
 *
 * Tests that need to assert exact semantic event sequences (e.g. "no
 * additional content events when the actor only sees turn boundaries") should
 * either continue to construct their own `processStream` without this wrapper
 * or filter on event types they care about.
 */

type ActorLike = { key: string; id: string };

type UserProcessStream = (
  vm: any,
  actor: ActorLike,
  stream?: unknown,
  options?: { signal?: AbortSignal },
) => Promise<any>;

export function createMockProcessStream(impl: () => Promise<any> | any): UserProcessStream;
export function createMockProcessStream(impl: UserProcessStream): UserProcessStream;
export function createMockProcessStream(impl: any): UserProcessStream {
  return async (vm: any, actor: ActorLike, stream?: unknown, options?: { signal?: AbortSignal }) => {
    const arity = typeof impl === "function" ? impl.length : 0;
    const msg = arity >= 2
      ? await impl(vm, actor, stream, options)
      : await impl();
    emitAssistantEnvelopeOnBus(vm?.eventBus, actor, msg);
    return msg;
  };
}

/**
 * Emit the assistant turn that `msg` represents as a semantic envelope on
 * the vm event bus, in the same shape the production LLM ingress pipeline
 * produces. Exported for tests that drive `processStream` indirectly (e.g.
 * via callbacks installed before the runtime is wired) and need to mirror
 * the same emit shape without going through {@link createMockProcessStream}.
 */
export function emitAssistantEnvelopeOnBus(
  bus: AgentEventGraph | null | undefined,
  actor: ActorLike,
  msg: any,
): void {
  if (!bus || typeof (bus as any).emit !== "function") return;
  const actorRef = { key: actor.key, id: actor.id };
  const reasoning = typeof msg?.reasoning_content === "string" ? msg.reasoning_content : "";
  const content = typeof msg?.content === "string" ? msg.content : "";
  if (reasoning) {
    bus.emitThinkStart(actorRef);
    bus.emitThinkDelta(actorRef, reasoning);
    bus.emitThinkEnd(actorRef);
  }
  bus.emitContentStart(actorRef);
  if (content) bus.emitContentDelta(actorRef, content);
  bus.emitContentEnd(actorRef);
  const toolCalls = Array.isArray(msg?.tool_calls)
    ? msg.tool_calls
    : Array.isArray(msg?.toolCalls)
      ? msg.toolCalls
      : [];
  for (const toolCall of toolCalls) {
    const fn = toolCall?.function && typeof toolCall.function === "object" ? toolCall.function : null;
    const argumentsText = typeof fn?.arguments === "string"
      ? fn.arguments
      : JSON.stringify(toolCall?.input ?? toolCall?.arguments ?? {});
    bus.emitToolCall(
      actorRef,
      {
        id: String(toolCall?.id ?? ""),
        functionName: String(fn?.name ?? toolCall?.name ?? ""),
        functionArguments: argumentsText,
      },
      "tool",
      "json",
    );
  }
  if (toolCalls.length === 0) {
    bus.emitAgentTurnEnd(actorRef, "assistant_message_committed");
  }
}
