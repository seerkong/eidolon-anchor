import { OutputStream } from "@cell/symbiont-contract/stream/stream";

export type OpenAICompletionsStreamAdapterParams =
  | {
      timeline: OutputStream;
      ingressControl?: undefined;
      ingressThink?: undefined;
      ingressContent?: undefined;
      ingressTool?: undefined;
    }
  | {
      timeline?: undefined;
      ingressControl: OutputStream;
      ingressThink: OutputStream;
      ingressContent: OutputStream;
      ingressTool: OutputStream;
    };

export class ToolCallAccumulator {
  id = "";
  type = "function";
  functionName = "";
  functionArguments = "";
}

function normalizeContent(content: unknown): string {
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  }
  if (content === null || content === undefined) return "";
  return String(content);
}

export class OpenAICompletionsNodejsFetchStreamAdapter {
  private timeline?: OutputStream;
  private ingressControl?: OutputStream;
  private ingressThink?: OutputStream;
  private ingressContent?: OutputStream;
  private ingressTool?: OutputStream;
  private toolCalls: Record<number, ToolCallAccumulator> = {};
  private thinkBuffer = "";
  private contentBuffer = "";
  private reasoningDetails: any[] = [];
  private pending = "";
  private inThink = false;
  private lastChunkFingerprint: string | null = null;

  constructor(params: OpenAICompletionsStreamAdapterParams) {
    if ("timeline" in params) {
      this.timeline = params.timeline;
    } else {
      this.ingressControl = params.ingressControl;
      this.ingressThink = params.ingressThink;
      this.ingressContent = params.ingressContent;
      this.ingressTool = params.ingressTool;
    }
  }

  private async send(event: "control" | "think" | "content" | "tool", data: string) {
    if (this.timeline) {
      await this.timeline.send(event, data);
      return;
    }
    switch (event) {
      case "control":
        if (this.ingressControl) await this.ingressControl.send(event, data);
        return;
      case "think":
        if (this.ingressThink) await this.ingressThink.send(event, data);
        return;
      case "content":
        if (this.ingressContent) await this.ingressContent.send(event, data);
        return;
      case "tool":
        if (this.ingressTool) await this.ingressTool.send(event, data);
        return;
      default:
        return;
    }
  }

  async processStream(stream: AsyncIterable<any>) {
    await this.send("control", JSON.stringify({ event: "StreamStart" }));
    try {
      for await (const chunk of stream as any) {
        await this.processChunk(chunk);
      }
      if (Object.keys(this.toolCalls).length) {
        for (const [, tc] of Object.entries(this.toolCalls)) {
          const tool_call = {
            id: tc.id,
            type: tc.type,
            function: {
              name: tc.functionName,
              arguments: tc.functionArguments,
            },
          };
          await this.send("tool", JSON.stringify(tool_call));
        }
      }
      return this.buildMessage();
    } finally {
      await this.send("control", JSON.stringify({ event: "StreamEnd" }));
    }
  }

  private async processChunk(chunk: any) {
    if (process.env.MINIMAX_DEBUG === "1") {
      const choice = chunk?.choices?.[0];
      const finish = choice?.finish_reason;
      const delta = choice?.delta || {};
      console.log("[openai] chunk", JSON.stringify({ finish_reason: finish, delta }, null, 2));
    }
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta || {};
    const fingerprint = fingerprintChunk(choice, delta, chunk);
    if (fingerprint && fingerprint === this.lastChunkFingerprint) {
      return;
    }
    this.lastChunkFingerprint = fingerprint;
    const content = normalizeContent(delta.content);
    await this.processReasoning(chunk, choice, delta, content);
    if (content) await this.processContent(content);
    if (delta.tool_calls) {
      for (const tcDelta of delta.tool_calls) {
        await this.processToolCall(tcDelta);
      }
    }
  }

  private async processReasoning(chunk: any, choice: any, delta: any, contentText: string) {
    const payloads: any[] = [];
    if (chunk?.reasoning_details) payloads.push(...chunk.reasoning_details);
    if (choice?.reasoning_details) payloads.push(...choice.reasoning_details);
    if (delta?.reasoning_details) payloads.push(...delta.reasoning_details);
    for (const detail of payloads) {
      if (detail && typeof detail === "object" && "text" in detail) {
        const text = String(detail.text ?? "");
        if (!text) continue;
        this.reasoningDetails.push(detail);
        this.thinkBuffer += text;
        await this.send("think", text);
      }
    }

    const interleavedReasoning = normalizeContent(
      delta?.reasoning_content ?? choice?.reasoning_content ?? chunk?.reasoning_content
    );
    if (interleavedReasoning && interleavedReasoning !== contentText) {
      this.thinkBuffer += interleavedReasoning;
      await this.send("think", interleavedReasoning);
    }
  }

  private async processContent(content: string) {
    if (!content) return;
    const segments = this.splitThinkSegments(content);
    for (const seg of segments) {
      if (!seg.text) continue;
      if (seg.isThink) {
        this.thinkBuffer += seg.text;
        await this.send("think", seg.text);
      } else {
        this.contentBuffer += seg.text;
        await this.send("content", seg.text);
      }
    }
  }

  private splitThinkSegments(chunk: string): Array<{ text: string; isThink: boolean }> {
    let buffer = this.pending + chunk;
    const segments: Array<{ text: string; isThink: boolean }> = [];
    this.pending = "";

    while (buffer.length) {
      if (this.inThink) {
        const endIdx = buffer.indexOf("</think>");
        if (endIdx === -1) {
          const tail = this.splitTagTail(buffer);
          const text = tail.emit;
          if (text) segments.push({ text, isThink: true });
          this.pending = tail.keep;
          buffer = "";
          break;
        }
        const text = buffer.slice(0, endIdx);
        if (text) segments.push({ text, isThink: true });
        buffer = buffer.slice(endIdx + "</think>".length);
        this.inThink = false;
        continue;
      }

      const startIdx = buffer.indexOf("<think>");
      if (startIdx === -1) {
        const tail = this.splitTagTail(buffer);
        if (tail.emit) segments.push({ text: tail.emit, isThink: false });
        this.pending = tail.keep;
        buffer = "";
        break;
      }
      const before = buffer.slice(0, startIdx);
      if (before) segments.push({ text: before, isThink: false });
      buffer = buffer.slice(startIdx + "<think>".length);
      this.inThink = true;
    }

    return segments;
  }

  private splitTagTail(text: string): { emit: string; keep: string } {
    const tokens = ["<think>", "</think>"];
    let keep = "";
    for (let i = 1; i < Math.min(text.length + 1, 8); i++) {
      const tail = text.slice(-i);
      if (tokens.some((tok) => tok.startsWith(tail))) {
        keep = tail;
      }
    }
    if (!keep) return { emit: text, keep: "" };
    return { emit: text.slice(0, text.length - keep.length), keep };
  }

  private async processToolCall(tcDelta: any) {
    const index = tcDelta.index;
    if (!(index in this.toolCalls)) this.toolCalls[index] = new ToolCallAccumulator();
    const tc = this.toolCalls[index];
    if (tcDelta.id) tc.id = tcDelta.id;
    if (tcDelta.type) tc.type = tcDelta.type;
    if (tcDelta.function) {
      const func = tcDelta.function;
      if (func.name) tc.functionName += func.name;
      if (func.arguments) tc.functionArguments += func.arguments;
    }
  }

  private buildMessage() {
    const msg: any = { role: "assistant", content: this.contentBuffer || null };
    if (Object.keys(this.toolCalls).length) {
      msg.tool_calls = Object.values(this.toolCalls).map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: {
          name: tc.functionName,
          arguments: tc.functionArguments,
        },
      }));
    }
    if (this.thinkBuffer) msg.reasoning_content = this.thinkBuffer;
    if (this.reasoningDetails.length) msg.reasoning_details = this.reasoningDetails;
    return msg;
  }
}

function fingerprintChunk(choice: any, delta: any, chunk: any): string | null {
  const normalized = {
    reasoning_details:
      Array.isArray(chunk?.reasoning_details) && chunk.reasoning_details.length > 0
        ? chunk.reasoning_details
        : Array.isArray(choice?.reasoning_details) && choice.reasoning_details.length > 0
          ? choice.reasoning_details
          : Array.isArray(delta?.reasoning_details) && delta.reasoning_details.length > 0
            ? delta.reasoning_details
            : undefined,
    reasoning_content:
      delta?.reasoning_content ?? choice?.reasoning_content ?? chunk?.reasoning_content ?? undefined,
    content: delta?.content ?? undefined,
    tool_calls: Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0 ? delta.tool_calls : undefined,
    finish_reason: choice?.finish_reason ?? undefined,
  };

  if (
    normalized.reasoning_details === undefined &&
    normalized.reasoning_content === undefined &&
    normalized.content === undefined &&
    normalized.tool_calls === undefined &&
    normalized.finish_reason === undefined
  ) {
    return null;
  }

  try {
    return JSON.stringify(normalized);
  } catch {
    return null;
  }
}
