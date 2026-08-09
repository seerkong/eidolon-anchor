import { describe, expect, test } from "bun:test";

import {
  BoundedEventLog,
  BoundedTimeline,
} from "@cell/symbiont-logic/stream/BoundedTimeline";

describe("bounded live timeline", () => {
  test("retains only the configured replay window while sequence stays monotonic", () => {
    const timeline = new BoundedTimeline<string>({ retentionLimit: 3 });

    for (let index = 0; index < 10; index += 1) {
      timeline.append(`event-${index}`);
    }

    expect(timeline.size()).toBe(3);
    expect(timeline.entries().map((entry) => [entry.seq, entry.value])).toEqual([
      [8, "event-7"],
      [9, "event-8"],
      [10, "event-9"],
    ]);
  });

  test("zero retention preserves synchronous ordered fan-out", () => {
    const log = new BoundedEventLog<string>({ retentionLimit: 0 });
    const observed: string[] = [];
    log.stream({ replay: false }).subscribe({
      next: (entry) => observed.push(`first:${entry.value}`),
    });
    log.stream({ replay: false }).subscribe({
      next: (entry) => observed.push(`second:${entry.value}`),
    });

    log.append("one");
    observed.push("after-append");

    expect(observed).toEqual(["first:one", "second:one", "after-append"]);
    expect(log.size()).toBe(0);
    expect(log.entries()).toEqual([]);
  });

  test("channels fan into the parent and keep an independently bounded replay window", () => {
    const timeline = new BoundedTimeline<string>({ retentionLimit: 2 });
    const channel = timeline.createChannel("tool");
    const parentLive: string[] = [];
    const channelLive: string[] = [];
    timeline.stream({ replay: false }).subscribe({ next: (entry) => parentLive.push(entry.value) });
    channel.stream({ replay: false }).subscribe({ next: (entry) => channelLive.push(entry.value) });

    channel.append("a");
    channel.append("b");
    channel.append("c");

    expect(parentLive).toEqual(["a", "b", "c"]);
    expect(channelLive).toEqual(["a", "b", "c"]);
    expect(timeline.entries().map((entry) => entry.value)).toEqual(["b", "c"]);
    expect(channel.entries().map((entry) => entry.value)).toEqual(["b", "c"]);
  });

  test("dispose releases retained replay payloads", () => {
    const timeline = new BoundedTimeline<string>({ retentionLimit: 4 });
    timeline.append("payload");
    timeline.dispose();

    expect(timeline.size()).toBe(0);
    expect(timeline.entries()).toEqual([]);
    expect(() => timeline.append("late")).toThrow("BoundedTimeline is disposed");
  });
});
