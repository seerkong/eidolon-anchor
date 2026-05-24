import { describe, expect, it } from "bun:test";

import { StreamTranscript } from "@cell/symbiont-logic/stream/StreamTranscript";

describe("StreamTranscript", () => {
  it("serializes records with header and markers", () => {
    const text = StreamTranscript.serialize(
      [
        { stream: "alpha", payload: "line1\nline2" },
        { stream: "beta", payload: "payload", marker: "mk-1" },
      ],
      { includeHeader: true, ensureMarker: true, markerGenerator: () => "gen-1" }
    );

    expect(text).toContain("@delimiter: ----");
    expect(text).toContain("---- #alpha ?gen-1");
    expect(text).toContain("---- #beta ?mk-1");
    expect(text).toContain("/?gen-1");
  });

  it("parses transcript text with custom delimiter and marker blocks", () => {
    const raw = [
      "@delimiter: ****",
      "**** #a ?m1",
      "hello",
      "/?m1",
      "**** #b",
      "world",
    ].join("\n");

    const parsed = StreamTranscript.parse(raw);
    expect(parsed.delimiter).toBe("****");
    expect(parsed.records.length).toBe(2);
    expect(parsed.records[0].stream).toBe("a");
    expect(parsed.records[0].marker).toBe("m1");
    expect(parsed.records[0].payload).toBe("hello");
    expect(parsed.records[1].stream).toBe("b");
    expect(parsed.records[1].payload).toBe("world");
  });

  it("preserves the next header when a marker block is truncated", () => {
    const raw = [
      "@delimiter: ----",
      "---- #tool_call_start ?mk-1",
      '{"toolName":"bash"',
      "---- #content ?mk-2",
      "done",
      "/?mk-2",
    ].join("\n");

    const parsed = StreamTranscript.parse(raw);
    expect(parsed.records.length).toBe(2);
    expect(parsed.records[0]).toEqual({ stream: "tool_call_start", payload: '{"toolName":"bash"', marker: "mk-1" });
    expect(parsed.records[1]).toEqual({ stream: "content", payload: "done", marker: "mk-2" });
  });

  it("returns empty string for no records", () => {
    const text = StreamTranscript.serialize([], {});
    expect(text).toBe("");
  });
});
