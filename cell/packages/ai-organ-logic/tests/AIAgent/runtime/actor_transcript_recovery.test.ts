import { describe, expect, it } from "bun:test"

import fs from "fs"
import os from "os"
import path from "path"

import { StreamTranscript } from "@cell/symbiont-logic/stream/StreamTranscript"
import {
  getActorTranscriptPaths,
  reduceTranscriptToMessages,
  serializeMessagesToTranscript,
} from "@cell/ai-core-logic/runtime/ActorTranscript"
import { LocalFileActorTranscriptStore } from "@cell/ai-support"

function makeTempSessionDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-actor-transcript-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe("Actor transcript recovery", () => {
  it("reduces event transcript into chat messages", () => {
    const text = StreamTranscript.serialize(
      [
        { stream: "user_input", payload: "hello" },
        { stream: "think", payload: "reason" },
        { stream: "content", payload: "done" },
        {
          stream: "tool_call_start",
          payload: JSON.stringify({ toolName: "DetachedBash", toolCallId: "tc-1", arguments: JSON.stringify({ cmd: "pwd" }) }),
        },
        {
          stream: "tool_call_result",
          payload: JSON.stringify({ toolName: "DetachedBash", toolCallId: "tc-1", result: "ok", isError: false }),
        },
      ],
      { delimiter: "----", includeHeader: true, ensureMarker: true },
    )

    const messages = reduceTranscriptToMessages(StreamTranscript.parse(text).records)
    expect(messages).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "done",
        reasoning_content: "reason",
        toolCalls: [{ id: "tc-1", name: "DetachedBash", input: { cmd: "pwd" } }],
        rawToolCalls: [{ id: "tc-1", name: "DetachedBash", input: { cmd: "pwd" } }],
        rawToolCallsStr: JSON.stringify([{ id: "tc-1", name: "DetachedBash", input: { cmd: "pwd" } }]),
      },
      { role: "tool", tool_call_id: "tc-1", content: "ok" },
    ])
  })

  it("serializes non-system messages to transcript and round-trips back", () => {
    const transcript = serializeMessagesToTranscript([
      { role: "system", content: "system prompt" },
      { role: "user", content: "user text" },
      { role: "assistant", content: "assistant text", reasoning_content: "why" },
      { role: "tool", content: "tool result", tool_call_id: "tc-2" } as any,
    ] as any)

    const messages = reduceTranscriptToMessages(StreamTranscript.parse(transcript).records)
    expect(messages).toEqual([
      { role: "user", content: "user text" },
      { role: "assistant", content: "assistant text", reasoning_content: "why" },
      { role: "tool", tool_call_id: "tc-2", content: "tool result" },
    ])
  })

  it("merges duplicate tool call transcript records for the same provider call id", () => {
    const text = StreamTranscript.serialize(
      [
        {
          stream: "tool_call",
          payload: JSON.stringify({
            type: "json",
            source: "tool",
            tool_call: { id: "tc-dup", functionName: "read", functionArguments: JSON.stringify({ filePath: "README.md" }) },
          }),
        },
        {
          stream: "tool_call_start",
          payload: JSON.stringify({ toolName: "read", toolCallId: "tc-dup", arguments: JSON.stringify({ filePath: "README.md" }) }),
        },
        {
          stream: "tool_call_result",
          payload: JSON.stringify({ toolName: "read", toolCallId: "tc-dup", result: "ok", isError: false }),
        },
      ],
      { delimiter: "----", includeHeader: true, ensureMarker: true },
    )

    const messages = reduceTranscriptToMessages(StreamTranscript.parse(text).records)
    expect(messages[0]).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "tc-dup", name: "read", input: { filePath: "README.md" } }],
    })
    expect(messages[0].toolCalls).toHaveLength(1)
    expect(messages[1]).toEqual({ role: "tool", tool_call_id: "tc-dup", content: "ok" })
  })

  it("parses planned tool calls from functionName and functionArguments fields", () => {
    const text = StreamTranscript.serialize(
      [
        {
          stream: "tool_call",
          payload: JSON.stringify({
            type: "json",
            source: "tool",
            tool_call: { id: "tc-planned", functionName: "read", functionArguments: JSON.stringify({ filePath: "package.json" }) },
          }),
        },
      ],
      { delimiter: "----", includeHeader: true, ensureMarker: true },
    )

    const messages = reduceTranscriptToMessages(StreamTranscript.parse(text).records)
    expect(messages).toEqual([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-planned", name: "read", input: { filePath: "package.json" } }],
        rawToolCalls: [{ id: "tc-planned", name: "read", input: { filePath: "package.json" } }],
        rawToolCallsStr: JSON.stringify([{ id: "tc-planned", name: "read", input: { filePath: "package.json" } }]),
      },
    ])
  })

  it("ignores malformed tool/questionnaire records but still recovers subsequent valid history", () => {
    const text = [
      "@delimiter: ----",
      "---- #user_input ?m1",
      "hello",
      "/?m1",
      "---- #tool_call_start ?m2",
      '{"toolName":"bash"',
      "---- #questionnaire_request ?m3",
      '{"questionnaireId":"q-1","toolCallId":"tc-1"}',
      "/?m3",
      "---- #content ?m4",
      "done",
      "/?m4",
    ].join("\n")

    const messages = reduceTranscriptToMessages(StreamTranscript.parse(text).records)
    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "done" },
    ])
  })

  it("does not read removed root message history layout when actor transcript is absent", async () => {
    const sessionDir = makeTempSessionDir()
    const paths = getActorTranscriptPaths(sessionDir, {
      agentKey: "main",
      actorId: "actor-main",
      actorType: "primary",
    })

    const removedPath = path.join(sessionDir, "message_history.txt")
    fs.mkdirSync(path.dirname(removedPath), { recursive: true })
    fs.writeFileSync(
      removedPath,
      StreamTranscript.serialize(
        [
          { stream: "user_input", payload: "removed hello" },
          { stream: "content", payload: "removed done" },
        ],
        { delimiter: "----", includeHeader: true, ensureMarker: true },
      ),
      "utf8",
    )

    const loaded = await LocalFileActorTranscriptStore.loadMessages({
      sessionDir,
      actor: {
        agentKey: "main",
        actorId: "actor-main",
        actorType: "primary",
      },
    })

    expect(loaded.source).toBe("empty")
    expect(loaded.messages).toEqual([])
  })

  it("reads actor-scoped transcript even when removed root history files also exist", async () => {
    const sessionDir = makeTempSessionDir()
    const paths = getActorTranscriptPaths(sessionDir, {
      agentKey: "main",
      actorId: "actor-main",
      actorType: "primary",
    })

    const removedPath = path.join(sessionDir, "message_history.txt")
    fs.mkdirSync(path.dirname(removedPath), { recursive: true })
    fs.mkdirSync(path.dirname(paths.transcriptPath), { recursive: true })
    fs.writeFileSync(
      removedPath,
      StreamTranscript.serialize([{ stream: "content", payload: "removed only" }], { delimiter: "----", includeHeader: true, ensureMarker: true }),
      "utf8",
    )
    fs.writeFileSync(
      paths.transcriptPath,
      StreamTranscript.serialize([{ stream: "content", payload: "new layout wins" }], { delimiter: "----", includeHeader: true, ensureMarker: true }),
      "utf8",
    )

    const loaded = await LocalFileActorTranscriptStore.loadMessages({
      sessionDir,
      actor: {
        agentKey: "main",
        actorId: "actor-main",
        actorType: "primary",
      },
    })

    expect(loaded.source).toBe("transcript")
    expect(loaded.messages).toEqual([{ role: "assistant", content: "new layout wins" }])
  })

  it("does not fall back to snapshot messages when transcript history is missing", async () => {
    const sessionDir = makeTempSessionDir()
    const paths = getActorTranscriptPaths(sessionDir, {
      agentKey: "main",
      actorId: "actor-main",
      actorType: "primary",
    })

    const loaded = await LocalFileActorTranscriptStore.loadMessages({
      sessionDir,
      actor: {
        agentKey: "main",
        actorId: "actor-main",
        actorType: "primary",
      },
    })

    expect(loaded.source).toBe("empty")
    expect(loaded.messages).toEqual([])
  })
})
