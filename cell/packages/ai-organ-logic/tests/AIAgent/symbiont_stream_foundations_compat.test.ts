import { describe, expect, it } from "bun:test";

import { OutputStream, TeeOutputStream } from "@cell/symbiont-contract/stream/stream";
import { IngressStreams } from "@cell/symbiont-logic/stream/IngressStreams";
import { IngressStreamRuntime } from "@cell/symbiont-logic/stream/IngressStreamRuntime";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("symbiont stream foundations compatibility", () => {
  it("TeeOutputStream mirrors writes into timeline while preserving local stream visibility", async () => {
    const timeline = new OutputStream();
    const tee = new TeeOutputStream(timeline);

    const timelineEvents: Array<{ event: string; data: string }> = [];
    const localEvents: Array<{ event: string; data: string }> = [];

    timeline.onData((ev) => timelineEvents.push(ev));
    tee.onData((ev) => localEvents.push(ev));

    await tee.send("content", "hello");
    await tee.send("tool", "{\"ok\":true}");
    await tick();

    expect(timelineEvents).toEqual([
      { event: "content", data: "hello" },
      { event: "tool", data: "{\"ok\":true}" },
    ]);
    expect(localEvents).toEqual(timelineEvents);
  });

  it("OutputStream async iterator drains queued events and terminates on close", async () => {
    const output = new OutputStream();

    const drain = (async () => {
      const seen: Array<{ event: string; data: string }> = [];
      for await (const ev of output) {
        seen.push(ev);
      }
      return seen;
    })();

    await output.send("think", "step-1");
    await output.send("content", "done");
    await output.close();

    expect(await drain).toEqual([
      { event: "think", data: "step-1" },
      { event: "content", data: "done" },
    ]);
  });

  it("IngressStreams fans channel writes into timeline while keeping per-channel streams isolated", async () => {
    const ingress = new IngressStreams();

    const timelineEvents: Array<{ event: string; data: string }> = [];
    const contentEvents: Array<{ event: string; data: string }> = [];
    const thinkEvents: Array<{ event: string; data: string }> = [];

    ingress.timeline.onData((ev) => timelineEvents.push(ev));
    ingress.content.onData((ev) => contentEvents.push(ev));
    ingress.think.onData((ev) => thinkEvents.push(ev));

    await ingress.content.send("content", "a");
    await ingress.think.send("think", "b");
    await tick();

    expect(timelineEvents).toEqual([
      { event: "content", data: "a" },
      { event: "think", data: "b" },
    ]);
    expect(contentEvents).toEqual([{ event: "content", data: "a" }]);
    expect(thinkEvents).toEqual([{ event: "think", data: "b" }]);
  });

  it("IngressStreamRuntime.ingressStreams returns a compatibility surface backed by the runtime timeline", async () => {
    const runtime = IngressStreamRuntime.create();
    const ingress = runtime.ingressStreams;

    const timelineEvents: Array<{ event: string; data: string }> = [];
    const toolEvents: Array<{ event: string; data: string }> = [];

    runtime.timelineStream.onData((ev) => timelineEvents.push(ev));
    ingress.tool.onData((ev) => toolEvents.push(ev));

    await ingress.tool.send("tool", "call");
    await tick();

    expect(ingress.timeline).toBe(runtime.timelineStream);
    expect(ingress.control).toBe(runtime.ingressControl);
    expect(ingress.think).toBe(runtime.ingressThink);
    expect(ingress.content).toBe(runtime.ingressContent);
    expect(ingress.tool).toBe(runtime.ingressTool);
    expect(toolEvents).toEqual([{ event: "tool", data: "call" }]);
    expect(timelineEvents).toEqual([{ event: "tool", data: "call" }]);
  });
});
