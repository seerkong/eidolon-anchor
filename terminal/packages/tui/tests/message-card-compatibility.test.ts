import { describe, expect, it } from "bun:test"
import type { Message, Part, Session } from "@terminal/core/AIAgent"
import {
  CODING_TOOL_CARD_ALLOWLIST,
  GenericTool,
  ORCHESTRATION_TOOL_CARD_ALLOWLIST,
  RESEARCH_TOOL_CARD_ALLOWLIST,
  resolveTuiA1ToolCard,
  TOOL_CARD_REGISTRY,
} from "../src/app/tui_a1/features/message/model/tool-registry"
import { runtimeMessagesToTuiA1Messages } from "../src/app/tui_a1/data"
import { TuiA1StateGraph } from "../src/app/tui_a1/graph"
import {
  buildPromptInfoFromParts,
  extractMessageText,
  hasDisplayableTextPart,
  summarizeSessionRevert,
} from "../src/app/tui_a1/features/message/model/session-helpers"
import { filetype, normalizePath } from "../src/app/tui_a1/features/message/model/path-utils"

describe("message card compatibility", () => {
  it("projects assistant text and tool parts into a flat timeline in part order", () => {
    const message: Message = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "assistant",
      agent: "build",
      modelID: "gpt-5.4",
      providerID: "openai",
      mode: "assist",
      path: { cwd: process.cwd(), root: process.cwd() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1 },
    }

    const parts: Part[] = [
      {
        id: "p1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text: "Before tool. ",
      },
      {
        id: "p2",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "tool",
        tool: "bash",
        callID: "call_1",
        state: {
          status: "pending",
          input: { command: "pwd" },
        },
      },
      {
        id: "p3",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text: "After tool.",
      },
      {
        id: "p4",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "tool",
        tool: "webfetch",
        callID: "call_2",
        state: {
          status: "completed",
          input: { url: "https://example.com" },
          output: "ok",
        },
      },
    ]

    const projected = runtimeMessagesToTuiA1Messages([message], {
      [message.id]: parts,
    })

    expect(projected).toHaveLength(4)
    expect(projected.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "assistant:msg_1:text:0",
      "tool:p2",
      "assistant:msg_1:text:1",
      "tool:p4",
    ])
    expect(projected[0]).toMatchObject({
      kind: "assistant",
      text: "Before tool. ",
    })
    expect(projected[1]).toMatchObject({
      kind: "tool",
      source: "runtime-part",
      tool: "bash",
      input: { command: "pwd" },
    })
    expect(projected[2]).toMatchObject({
      kind: "assistant",
      text: "After tool.",
    })
    expect(projected[3]).toMatchObject({
      kind: "tool",
      source: "runtime-part",
      tool: "webfetch",
      output: "ok",
    })
  })

  it("keeps dedicated structured tool card mappings", () => {
    expect(TOOL_CARD_REGISTRY.edit).toBeDefined()
    expect(TOOL_CARD_REGISTRY.multiedit).toBeDefined()
    expect(TOOL_CARD_REGISTRY.write).toBeDefined()
    expect(TOOL_CARD_REGISTRY.question).toBeDefined()
    expect(TOOL_CARD_REGISTRY.patch).toBeDefined()
    expect(TOOL_CARD_REGISTRY.apply_patch).toBeDefined()
    expect(TOOL_CARD_REGISTRY.task).toBeDefined()
    expect(TOOL_CARD_REGISTRY.tasktreewrite).toBeDefined()
    expect(TOOL_CARD_REGISTRY.tasktreeread).toBeDefined()

    expect(TOOL_CARD_REGISTRY.edit).not.toBe(GenericTool)
    expect(TOOL_CARD_REGISTRY.multiedit).not.toBe(GenericTool)
    expect(TOOL_CARD_REGISTRY.write).not.toBe(GenericTool)
    expect(TOOL_CARD_REGISTRY.question).not.toBe(GenericTool)
    expect(TOOL_CARD_REGISTRY.patch).not.toBe(GenericTool)
    expect(TOOL_CARD_REGISTRY.apply_patch).not.toBe(GenericTool)
    expect(TOOL_CARD_REGISTRY.task).not.toBe(GenericTool)
    expect(TOOL_CARD_REGISTRY.tasktreewrite).not.toBe(GenericTool)
    expect(TOOL_CARD_REGISTRY.tasktreeread).not.toBe(GenericTool)
  })

  it("routes coding and research tools to dedicated cards while keeping generic fallback", () => {
    expect(CODING_TOOL_CARD_ALLOWLIST).toEqual([
      "bash",
      "edit",
      "multiedit",
      "write",
      "read",
      "grep",
      "glob",
      "list",
      "patch",
      "apply_patch",
    ])
    expect(RESEARCH_TOOL_CARD_ALLOWLIST).toEqual(["webfetch", "codesearch", "websearch"])
    expect(ORCHESTRATION_TOOL_CARD_ALLOWLIST).toEqual(["task", "question", "tasktreewrite", "tasktreeread"])

    expect(resolveTuiA1ToolCard("edit")).toBe(TOOL_CARD_REGISTRY.edit)
    expect(resolveTuiA1ToolCard("multiedit")).toBe(TOOL_CARD_REGISTRY.multiedit)
    expect(resolveTuiA1ToolCard("patch")).toBe(TOOL_CARD_REGISTRY.patch)
    expect(resolveTuiA1ToolCard("apply_patch")).toBe(TOOL_CARD_REGISTRY.apply_patch)
    expect(resolveTuiA1ToolCard("webfetch")).toBe(TOOL_CARD_REGISTRY.webfetch)
    expect(resolveTuiA1ToolCard("codesearch")).toBe(TOOL_CARD_REGISTRY.codesearch)
    expect(resolveTuiA1ToolCard("websearch")).toBe(TOOL_CARD_REGISTRY.websearch)
    expect(resolveTuiA1ToolCard("task")).toBe(TOOL_CARD_REGISTRY.task)
    expect(resolveTuiA1ToolCard("question")).toBe(TOOL_CARD_REGISTRY.question)
    expect(resolveTuiA1ToolCard("tasktreewrite")).toBe(TOOL_CARD_REGISTRY.tasktreewrite)
    expect(resolveTuiA1ToolCard("tasktreeread")).toBe(TOOL_CARD_REGISTRY.tasktreeread)
    expect(resolveTuiA1ToolCard("edit_file")).toBe(GenericTool)
    expect(resolveTuiA1ToolCard("write_file")).toBe(GenericTool)
    expect(resolveTuiA1ToolCard("read_file")).toBe(GenericTool)
    expect(resolveTuiA1ToolCard("unknown-tool")).toBe(GenericTool)
  })

  it("keeps tool part identity stable across runtime updates", () => {
    const graph = new TuiA1StateGraph({
      initialMessages: [],
    })

    const message: Message = {
      id: "msg_2",
      sessionID: "ses_1",
      role: "assistant",
      agent: "build",
      modelID: "gpt-5.4",
      providerID: "openai",
      mode: "assist",
      path: { cwd: process.cwd(), root: process.cwd() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 2 },
    }

    graph.hydrateRuntimeSession({
      sessionID: "ses_1",
      busy: true,
      messages: [message],
      partsByMessage: {
        [message.id]: [
          {
            id: "tool_1",
            sessionID: "ses_1",
            messageID: "msg_2",
            type: "tool",
            tool: "bash",
            callID: "call_1",
            state: {
              status: "pending",
              input: { command: "pwd" },
            },
          },
        ],
      },
    })

    const before = graph
      .snapshot()
      .messages.find((item) => item.kind === "tool" && item.source === "runtime-part")
    expect(before).toMatchObject({
      id: "tool_1",
      kind: "tool",
      source: "runtime-part",
      tool: "bash",
    })

    graph.applyRuntimePartUpdated({
      id: "tool_1",
      sessionID: "ses_1",
      messageID: "msg_2",
      type: "tool",
      tool: "bash",
      callID: "call_1",
      state: {
        status: "completed",
        input: { command: "pwd" },
        output: "/tmp",
        metadata: {
          output: "/tmp",
        },
      },
    })

    const after = graph
      .snapshot()
      .messages.find((item) => item.kind === "tool" && item.source === "runtime-part")
    expect(after?.id).toBe(before?.id)
    expect(after).toMatchObject({
      kind: "tool",
      source: "runtime-part",
      output: "/tmp",
      metadata: {
        output: "/tmp",
      },
    })
    expect(after && "part" in after ? after.part.state.status : undefined).toBe("completed")
  })

  it("rebuilds prompt info from message parts without losing file attachments", () => {
    const parts: Part[] = [
      {
        id: "p1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text: "请修改 ",
      },
      {
        id: "p2",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "file",
        filename: "src/app.ts",
        mime: "text/plain",
        source: {
          type: "file",
          path: "src/app.ts",
        },
      },
      {
        id: "p3",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text: "这一段",
        synthetic: true,
      },
      {
        id: "p4",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text: "代码",
      },
    ]

    const prompt = buildPromptInfoFromParts(parts)
    expect(prompt.input).toBe("请修改 代码")
    expect(prompt.parts).toHaveLength(1)
    expect(prompt.parts[0]?.type).toBe("file")
    expect((prompt.parts[0] as any).filename).toBe("src/app.ts")
  })

  it("ignores synthetic and ignored text when extracting visible content", () => {
    const parts: Part[] = [
      {
        id: "p1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text: "可见文本",
      },
      {
        id: "p2",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text: "思考内容",
        synthetic: true,
      },
      {
        id: "p3",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text: "被忽略",
        ignored: true,
      },
    ]

    expect(extractMessageText(parts)).toBe("可见文本被忽略")
    expect(hasDisplayableTextPart(parts)).toBe(true)
    expect(
      hasDisplayableTextPart([
        {
          id: "p4",
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "text",
          text: "仅思考",
          synthetic: true,
        },
        {
          id: "p5",
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "text",
          text: "仅忽略",
          ignored: true,
        },
      ]),
    ).toBe(false)
  })

  it("summarizes revert state while preserving reverted user messages and file diff stats", () => {
    const revertInfo: Session["revert"] = {
      messageID: "msg_2",
      diff: [
        "diff --git a/foo.ts b/foo.ts",
        "--- a/foo.ts",
        "+++ b/foo.ts",
        "@@ -1,2 +1,3 @@",
        "-const a = 1",
        "+const a = 2",
        "+const b = 3",
      ].join("\n"),
    }

    const messages: Message[] = [
      {
        id: "msg_1",
        sessionID: "ses_1",
        role: "user",
        agent: "build",
        time: { created: 1 },
      },
      {
        id: "msg_2",
        sessionID: "ses_1",
        role: "user",
        agent: "build",
        time: { created: 2 },
      },
      {
        id: "msg_3",
        sessionID: "ses_1",
        role: "assistant",
        agent: "build",
        modelID: "shell-default",
        providerID: "eidolon",
        mode: "assist",
        path: { cwd: process.cwd(), root: process.cwd() },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 3 },
      },
      {
        id: "msg_4",
        sessionID: "ses_1",
        role: "user",
        agent: "build",
        time: { created: 4 },
      },
    ]

    const summary = summarizeSessionRevert(revertInfo, messages)
    expect(summary?.messageID).toBe("msg_2")
    expect(summary?.reverted.map((message) => message.id)).toEqual(["msg_2", "msg_4"])
    expect(summary?.diff).toContain("diff --git a/foo.ts b/foo.ts")
    expect(summary?.diffFiles).toEqual([
      { filename: "foo.ts", additions: 2, deletions: 1 },
    ])
  })

  it("normalizes paths and resolves filetypes used by file/edit cards", () => {
    const homePath = `${process.env.HOME ?? "/tmp"}/demo/example.py`
    expect(normalizePath("src/app.ts")).toBe("src/app.ts")
    expect(normalizePath(process.cwd())).toBe(".")
    expect(normalizePath(homePath).startsWith("~")).toBe(true)

    expect(filetype("src/app.ts")).toBe("typescript")
    expect(filetype("src/legacy.js")).toBe("typescript")
    expect(filetype("tools/run.py")).toBe("python")
    expect(filetype("README.unknown")).toBe("none")
  })
})
