import { describe, expect, it } from "bun:test";

import { OpenAICompletionsNodejsFetchStreamAdapter } from "@cell/symbiont-logic/stream/OpenAICompletionsNodejsFetchStreamAdapter";
import { OutputStream } from "@cell/symbiont-contract/stream/stream";

describe("OpenAICompletionsNodejsFetchStreamAdapter", () => {
  it("captures interleaved reasoning_content into reasoning_content field", async () => {
    const timeline = new OutputStream();
    const adapter = new OpenAICompletionsNodejsFetchStreamAdapter({ timeline });
    const events: Array<{ event: string; data: string }> = [];
    timeline.onData((ev) => events.push(ev));

    async function* stream() {
      yield {
        choices: [
          {
            delta: {
              reasoning_content: [{ text: "step-1 " }],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              reasoning_content: "step-2",
              content: "answer",
            },
          },
        ],
      };
    }

    const msg = await adapter.processStream(stream());

    expect(msg.reasoning_content).toBe("step-1 step-2");
    expect(msg.content).toBe("answer");
    expect(events.filter((ev) => ev.event === "think").map((ev) => ev.data).join("")).toBe("step-1 step-2");
  });

  it("deduplicates identical consecutive chunks before entering the event graph", async () => {
    const timeline = new OutputStream();
    const adapter = new OpenAICompletionsNodejsFetchStreamAdapter({ timeline });
    const events: Array<{ event: string; data: string }> = [];
    timeline.onData((ev) => events.push(ev));

    const repeatedReasoningChunk = {
      choices: [
        {
          delta: {
            reasoning_content: "Great",
          },
        },
      ],
    };
    const repeatedContentChunk = {
      choices: [
        {
          delta: {
            content: "Created member successfully",
          },
        },
      ],
    };

    async function* stream() {
      yield repeatedReasoningChunk;
      yield repeatedReasoningChunk;
      yield repeatedContentChunk;
      yield repeatedContentChunk;
    }

    const msg = await adapter.processStream(stream());

    expect(msg.reasoning_content).toBe("Great");
    expect(msg.content).toBe("Created member successfully");
    expect(events.filter((ev) => ev.event === "think").map((ev) => ev.data)).toEqual(["Great"]);
    expect(events.filter((ev) => ev.event === "content").map((ev) => ev.data)).toEqual(["Created member successfully"]);
  });

  it("suppresses mirrored reasoning_content when it is identical to content in the same chunk", async () => {
    const timeline = new OutputStream();
    const adapter = new OpenAICompletionsNodejsFetchStreamAdapter({ timeline });
    const events: Array<{ event: string; data: string }> = [];
    timeline.onData((ev) => events.push(ev));

    async function* stream() {
      yield {
        choices: [
          {
            delta: {
              reasoning_content: "我是你的AI助手",
              content: "我是你的AI助手",
            },
          },
        ],
      };
    }

    const msg = await adapter.processStream(stream());

    expect(msg.reasoning_content ?? "").toBe("");
    expect(msg.content).toBe("我是你的AI助手");
    expect(events.filter((ev) => ev.event === "think").length).toBe(0);
    expect(events.filter((ev) => ev.event === "content").map((ev) => ev.data)).toEqual(["我是你的AI助手"]);
  });

  it("closes the visible stream lifecycle when the provider stream throws", async () => {
    const timeline = new OutputStream();
    const adapter = new OpenAICompletionsNodejsFetchStreamAdapter({ timeline });
    const events: Array<{ event: string; data: string }> = [];
    timeline.onData((ev) => events.push(ev));

    async function* stream() {
      yield {
        choices: [
          {
            delta: {
              content: "partial",
            },
          },
        ],
      };
      throw new Error("provider stream aborted");
    }

    await expect(adapter.processStream(stream())).rejects.toThrow("provider stream aborted");
    expect(events.filter((ev) => ev.event === "control").map((ev) => JSON.parse(ev.data).event)).toEqual([
      "StreamStart",
      "StreamEnd",
    ]);
  });
});
