/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { MessageCards } from "../src/app/tui_a1/features/message/cards"
import { TuiA1View } from "../src/app/tui_a1"
import { sessionContext } from "../src/app/tui_a1/features/message/model/session-context"
import { tuiA1Theme as theme } from "../src/app/tui_a1/theme"

const now = Date.now()

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function tool(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
  output?: string,
) {
  return {
    id,
    kind: "tool" as const,
    source: "runtime-part" as const,
    tool: toolName,
    createdAt: now,
    input,
    metadata,
    output,
    part: {
      id,
      sessionID: "ses_1",
      messageID: `msg_${id}`,
      type: "tool" as const,
      tool: toolName,
      callID: `call_${id}`,
      state: {
        status: output ? "completed" : "pending",
        input,
        output,
        metadata,
      },
    },
  }
}

describe("tui_a1 tool card render", () => {
  it("shares one renderer resize listener across a long list of framed messages", async () => {
    const messages = [
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `history-${index}`,
        kind: "assistant" as const,
        createdAt: now + index,
        text: `restored message ${index}`,
      })),
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `summary-${index}`,
        kind: "tool" as const,
        source: "summary" as const,
        tool: "history-summary",
        createdAt: now + index,
        status: "done" as const,
        summary: `restored tool summary ${index}`,
      })),
    ]
    const setup = await testRender(
      () => (
        <box width="100%" height="100%">
          <MessageCards messages={messages as any} />
        </box>
      ),
      {
        width: 80,
        height: 20,
      },
    )

    try {
      await setup.renderOnce()
      expect(setup.renderer.listenerCount("resize")).toBeLessThanOrEqual(1)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("mounts the viewport window through the host capsule, not the card renderer", async () => {
    const messages = Array.from({ length: 300 }, (_, index) => ({
      id: `virtual-${index}`,
      kind: "assistant" as const,
      createdAt: now + index,
      text: `virtual message ${index}`,
    }))
    const setup = await testRender(
      () => (
        <TuiA1View directory={process.cwd()} initialMessages={messages} />
      ),
      { width: 80, height: 20 },
    )
    try {
      for (let frame = 0; frame < 20; frame++) {
        await new Promise(resolve => setTimeout(resolve, 0))
        await setup.renderOnce()
        if (setup.captureCharFrame().includes("virtual message 299")) break
      }
      const text = setup.captureSpans().lines
        .map((line) => line.spans.map((span) => span.text).join(""))
        .join("\n")
      const rendered = text.match(/virtual message \d+/g) ?? []
      expect(rendered.length).toBeGreaterThan(0)
      expect(rendered.length).toBeLessThan(30)
      expect(text).toContain("virtual message 299")
      expect(text).not.toContain("virtual message 0")
      expect(setup.renderer.listenerCount("resize")).toBeLessThanOrEqual(1)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders message cards with full header and end time on open horizontal borders", async () => {
    const completedAt = now + 65_000
    const setup = await testRender(
      () => (
        <box width="100%" height="100%">
          <MessageCards
            messages={[
              {
                id: "a1",
                kind: "assistant",
                createdAt: now,
                completedAt,
                selection: {
                  agent: "code",
                  providerID: "deepseek",
                  modelID: "deepseek-v4-pro",
                },
                text: "border sample",
              },
            ] as any}
          />
        </box>
      ),
      {
        width: 80,
        height: 10,
      },
    )

    try {
      await setup.renderOnce()

      const frame = setup.captureSpans()
      const lines = frame.lines.map((line) => line.spans.map((span) => span.text).join(""))
      const text = lines.join("\n")
      const topLine = lines.find((line) => line.startsWith("╭")) ?? ""
      const bodyLine = lines.find((line) => line.includes("border sample")) ?? ""
      const bottomLine = lines.find((line) => line.startsWith("╰")) ?? ""

      expect(text).toContain("╭─ ASSISTANT (Code · deepseek/deepseek-v4-pro)")
      expect(topLine).toContain(`─ ${formatTime(now)} ─╮`)
      expect(topLine.trimEnd().endsWith("╮")).toBe(true)
      expect(topLine.indexOf("╮")).toBe(78)
      expect(bottomLine).toContain(`─ ${formatTime(completedAt)} ─╯`)
      expect(bottomLine.trimEnd().endsWith("╯")).toBe(true)
      expect(bottomLine.indexOf("╯")).toBe(78)
      expect(bodyLine.startsWith(" border sample")).toBe(true)
      expect(text).toContain(formatTime(now))
      expect(text).toContain(formatTime(completedAt))
      expect(text).toContain("border sample")
      expect(text).not.toContain("┃")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders thinking frame text with the same muted contrast as thinking content", async () => {
    const setup = await testRender(
      () => (
        <box width="100%" height="100%">
          <MessageCards
            messages={[
              {
                id: "t1",
                kind: "assistant",
                mode: "think",
                createdAt: now,
                text: "reasoning body",
              },
            ] as any}
          />
        </box>
      ),
      {
        width: 80,
        height: 10,
      },
    )

    try {
      await setup.renderOnce()

      const frame = setup.captureSpans()
      const thinkingLine = frame.lines
        .flatMap((line) => line.spans)
        .find((span) => span.text.includes("THINKING"))
      const bodyLine = frame.lines.flatMap((line) => line.spans).find((span) => span.text.includes("reasoning body"))

      expect(thinkingLine?.fg).toEqual(theme.textMuted)
      expect(bodyLine?.fg).toEqual(theme.textMuted)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders user card header without the You label", async () => {
    const setup = await testRender(
      () => (
        <box width="100%" height="100%">
          <MessageCards
            messages={[
              {
                id: "u1",
                kind: "user",
                createdAt: now,
                text: "user body",
              },
            ] as any}
          />
        </box>
      ),
      {
        width: 80,
        height: 10,
      },
    )

    try {
      await setup.renderOnce()

      const frame = setup.captureSpans()
      const lines = frame.lines.map((line) => line.spans.map((span) => span.text).join(""))
      const topLine = lines.find((line) => line.startsWith("╭")) ?? ""
      expect(topLine).toContain("╭─ USER ")
      expect(topLine).not.toContain("USER You")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("omits the bottom end time while a message is still streaming", async () => {
    const setup = await testRender(
      () => (
        <box width="100%" height="100%">
          <MessageCards
            messages={[
              {
                id: "a1",
                kind: "assistant",
                createdAt: now,
                streaming: true,
                text: "streaming sample",
              },
            ] as any}
          />
        </box>
      ),
      {
        width: 80,
        height: 10,
      },
    )

    try {
      await setup.renderOnce()

      const frame = setup.captureSpans()
      const lines = frame.lines.map((line) => line.spans.map((span) => span.text).join(""))
      const bottomLine = lines.find((line) => line.startsWith("╰")) ?? ""
      expect(bottomLine).not.toContain(formatTime(now))
      expect(lines.join("\n")).toContain("streaming sample")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders compact dedicated cards for coding and research runtime tool parts", async () => {
    const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))
    const messages = [
      {
        id: "a1",
        kind: "assistant" as const,
        createdAt: now,
        text: "verify cards",
      },
      tool("t1", "bash", { command: "tail -6 ~/tmp/demo3/AGENTS.md | cat -n" }, { output: "1 line" }, "1 line"),
      tool(
        "t1b",
        "write",
        { filePath: "~/tmp/demo3/AGENTS.md", content: "追加一行\n再追加一行" },
        {},
        "Wrote file successfully.",
      ),
      tool(
        "t2",
        "edit",
        { filePath: "~/tmp/demo3/AGENTS.md", oldString: "旧内容", newString: "新内容" },
        { diff: "@@ -1 +1 @@\n-旧内容\n+新内容" },
      ),
      tool(
        "t3",
        "websearch",
        { query: "latest bun release" },
        { numResults: 3 },
        JSON.stringify({ results: [{ title: "a" }, { title: "b" }, { title: "c" }] }),
      ),
    ]

    const RenderCards = () => {
      return (
        <sessionContext.Provider
          value={{
            width: 120,
            sessionID: "ses_1",
            directory: process.cwd(),
            conceal: () => false,
            activePermissionCallID: undefined,
            showThinking: () => true,
            showTimestamps: () => true,
            showDetails: () => true,
            diffWrapMode: () => "word",
            keybindLabel: () => "",
            navigateToSession: () => {},
            agentColor: () => RGBA.fromHex("#5ba8ff"),
          }}
        >
          <box width="100%" height="100%">
            <MessageCards messages={messages as any} />
          </box>
        </sessionContext.Provider>
      )
    }

    const setup = await testRender(() => <RenderCards />, {
      width: 120,
      height: 36,
    })

    try {
      await setup.renderOnce()
      await tick(20)
      await setup.renderOnce()

      const frame = setup.captureSpans()
      const spans = frame.lines.flatMap((line) => line.spans)
      const text = frame.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")
      expect(text).toContain("tail -6 ~/tmp/demo3/AGENTS.md | cat -n")
      expect(text).toContain("Wrote ~/tmp/demo3/AGENTS.md")
      expect(text).toContain("追加一行")
      expect(text).toContain("再追加一行")
      expect(text).toContain("Edit ~/tmp/demo3/AGENTS.md")
      expect(text).toContain("1 - 旧内容")
      expect(text).toContain("1 + 新内容")
      expect(text).toContain('Exa Web Search "latest bun release" (3 results)')
      expect(text).not.toContain("edit_file")
      expect(text).not.toContain('bash {"command":"tail -6 ~/tmp/demo3/AGENTS.md | cat -n"}')
      expect(spans.find((span) => span.text.includes("# Shell"))?.fg).toEqual(theme.toolBorder)
      expect(spans.find((span) => span.text.includes("# Wrote"))?.fg).toEqual(theme.toolBorder)
      expect(spans.find((span) => span.text.includes("← Edit"))?.fg).toEqual(theme.toolBorder)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("previews long write tool content instead of rendering the full file at once", async () => {
    const longContent = Array.from({ length: 80 }, (_, index) => `line-${index + 1}`).join("\n")
    const setup = await testRender(
      () => (
        <sessionContext.Provider
          value={{
            width: 120,
            sessionID: "ses_1",
            directory: process.cwd(),
            conceal: () => false,
            activePermissionCallID: undefined,
            showThinking: () => true,
            showTimestamps: () => true,
            showDetails: () => true,
            diffWrapMode: () => "word",
            keybindLabel: () => "",
            navigateToSession: () => {},
            agentColor: () => RGBA.fromHex("#5ba8ff"),
          }}
        >
          <box width="100%" height="100%">
            <MessageCards
              messages={[
                tool(
                  "long-write",
                  "write",
                  { filePath: "~/tmp/demo3/Long.java", content: longContent },
                  {},
                  "Wrote file successfully.",
                ),
              ] as any}
            />
          </box>
        </sessionContext.Provider>
      ),
      {
        width: 120,
        height: 36,
      },
    )

    try {
      await setup.renderOnce()

      const frame = setup.captureSpans()
      const text = frame.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")
      expect(text).toContain("line-1")
      expect(text).toContain("line-24")
      expect(text).toContain("Click to expand")
      expect(text).not.toContain("line-80")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("bounds restored edit diffs and single-line shell output until explicitly expanded", async () => {
    const longDiff = ["@@ -1,80 +1,80 @@", ...Array.from({ length: 80 }, (_, index) => `+line-${index + 1}`)].join("\n")
    const longShellLine = `shell-start-${"x".repeat(8_000)}-shell-end`
    const setup = await testRender(
      () => (
        <sessionContext.Provider
          value={{
            width: 120,
            sessionID: "ses_1",
            directory: process.cwd(),
            conceal: () => false,
            activePermissionCallID: undefined,
            showThinking: () => true,
            showTimestamps: () => true,
            showDetails: () => true,
            diffWrapMode: () => "word",
            keybindLabel: () => "",
            navigateToSession: () => {},
            agentColor: () => RGBA.fromHex("#5ba8ff"),
          }}
        >
          <box width="100%" height="100%">
            <MessageCards
              messages={[
                tool(
                  "long-edit",
                  "edit",
                  { filePath: "~/tmp/demo3/Long.java" },
                  { diff: longDiff },
                  "Edited file successfully.",
                ),
                tool(
                  "long-shell",
                  "bash",
                  { command: "produce-one-huge-line" },
                  { output: longShellLine },
                  longShellLine,
                ),
              ] as any}
            />
          </box>
        </sessionContext.Provider>
      ),
      { width: 120, height: 120 },
    )

    try {
      await setup.renderOnce()
      const text = setup.captureCharFrame()
      expect(text).toContain("line-1")
      expect(text).toContain("line-23")
      expect(text).not.toContain("line-80")
      expect(text).toContain("shell-start")
      expect(text).not.toContain("shell-end")
      expect(text.match(/Click to expand/g)?.length).toBe(2)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("bounds generic block tool titles to a percentage of the session width", async () => {
    const longDescription =
      "Inspect every generated ontology workspace package and retain the final operation-name.ts filename"
    const setup = await testRender(
      () => (
        <sessionContext.Provider
          value={{
            width: 80,
            sessionID: "ses_1",
            directory: process.cwd(),
            conceal: () => false,
            activePermissionCallID: undefined,
            showThinking: () => true,
            showTimestamps: () => true,
            showDetails: () => true,
            diffWrapMode: () => "word",
            keybindLabel: () => "",
            navigateToSession: () => {},
            agentColor: () => RGBA.fromHex("#5ba8ff"),
          }}
        >
          <box width="100%" height="100%">
            <MessageCards
              messages={[
                tool(
                  "long-bash-title",
                  "bash",
                  { command: "true", description: longDescription },
                  { output: "ok" },
                  "ok",
                ),
              ] as any}
            />
          </box>
        </sessionContext.Provider>
      ),
      { width: 80, height: 10 },
    )

    try {
      await setup.renderOnce()

      const frame = setup.captureSpans()
      const titleLine = frame.lines.map((line) => line.spans.map((span) => span.text).join("")).find((line) => line.includes("# Inspect")) ?? ""
      const renderedTitle = titleLine.match(/# (.*?) ─/)?.[1] ?? ""

      expect(renderedTitle.length).toBeLessThanOrEqual(Math.floor(80 * 0.8))
      expect(renderedTitle).toContain("…")
      expect(renderedTitle).toEndWith("operation-name.ts filename")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders context resource headers with readable contrast and a percentage-bounded path", async () => {
    const directory = process.cwd()
    const longRelativePath =
      "packages/depa-ontology/very-long-domain-segment/another-long-segment/ontology-modeling-design.md"
    const setup = await testRender(
      () => (
        <sessionContext.Provider
          value={{
            width: 80,
            sessionID: "ses_1",
            directory,
            conceal: () => false,
            activePermissionCallID: undefined,
            showThinking: () => true,
            showTimestamps: () => true,
            showDetails: () => true,
            diffWrapMode: () => "word",
            keybindLabel: () => "",
            navigateToSession: () => {},
            agentColor: () => RGBA.fromHex("#5ba8ff"),
          }}
        >
          <box width="100%" height="100%">
            <MessageCards
              messages={[
                tool(
                  "context-read",
                  "read",
                  { filePath: longRelativePath },
                  {
                    contextResource: {
                      resourceId: new URL(longRelativePath, `file://${directory}/`).href,
                      status: "loaded",
                      deliveredLines: "1-126",
                      sizeBytes: 3944,
                      revision: "e6df83352d39abcdef",
                      contentText: "context body",
                    },
                  },
                  "loaded context resource",
                ),
              ] as any}
            />
          </box>
        </sessionContext.Provider>
      ),
      {
        width: 80,
        height: 12,
      },
    )

    try {
      await setup.renderOnce()

      const frame = setup.captureSpans()
      const spans = frame.lines.flatMap((line) => line.spans)
      const lines = frame.lines.map((line) => line.spans.map((span) => span.text).join(""))
      const text = lines.join("\n")
      const contextTitle = spans.find((span) => span.text.includes("CONTEXT"))
      const renderedPath = lines.find((line) => line.includes("CONTEXT"))?.match(/CONTEXT (.*?) ─/)?.[1] ?? ""

      expect(contextTitle?.fg).toEqual(theme.info)
      expect(Array.from(renderedPath).length).toBeLessThanOrEqual(Math.floor(80 * 0.6))
      expect(text).toContain("…/ontology-modeling-design.md")
      expect(text).not.toContain(longRelativePath)
      expect(text).toContain("Loaded · lines 1-126 · 3944 B · e6df83352d39")
      expect(text).toContain("context body")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders orchestration cards without falling back to generic JSON summaries", async () => {
    const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))
    const messages = [
      tool(
        "task_1",
        "task",
        { delegate_type: "worker", description: "Investigate runtime approval drift" },
        {
          sessionId: "ses_child",
          summary: [
            {
              tool: "question",
              state: {
                status: "completed",
                title: "answered",
              },
            },
          ],
        },
      ),
      tool(
        "question_1",
        "question",
        {
          questions: [
            { question: "Execution mode", options: [{ label: "safe" }] },
            { question: "Scope", options: [{ label: "repo" }] },
          ],
        },
        { answers: [["safe"], []] },
      ),
      tool(
        "tree_1",
        "tasktreewrite",
        {},
        {},
        "Freeze contract\nWire history summary",
      ),
    ]

    const RenderCards = () => (
      <sessionContext.Provider
        value={{
          width: 120,
          sessionID: "ses_1",
          directory: process.cwd(),
          conceal: () => false,
          activePermissionCallID: undefined,
          showThinking: () => true,
          showTimestamps: () => true,
          showDetails: () => true,
          diffWrapMode: () => "word",
          keybindLabel: () => "ctrl+]",
          navigateToSession: () => {},
          agentColor: () => RGBA.fromHex("#5ba8ff"),
        }}
      >
        <box width="100%" height="100%">
          <MessageCards messages={messages as any} />
        </box>
      </sessionContext.Provider>
    )

    const setup = await testRender(() => <RenderCards />, {
      width: 120,
      height: 36,
    })

    try {
      await setup.renderOnce()
      await tick(20)
      await setup.renderOnce()

      const frame = setup.captureSpans()
      const spans = frame.lines.flatMap((line) => line.spans)
      const text = frame.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")
      expect(text).toContain("Worker Task")
      expect(text).toContain("Investigate runtime approval drift")
      expect(text).toContain("Execution mode")
      expect(text).toContain("safe")
      expect(text).toContain("Task Tree")
      expect(text).toContain("Freeze contract")
      expect(text).toContain("Wire history summary")
      expect(text).not.toContain('question {"questions"')
      expect(text).not.toContain('tasktreewrite {"tasks"')
      expect(spans.find((span) => span.text.includes("# Worker Task"))?.fg).toEqual(theme.toolBorder)
      expect(spans.find((span) => span.text.includes("# Questions"))?.fg).toEqual(theme.toolBorder)
      expect(spans.find((span) => span.text.includes("# Task Tree"))?.fg).toEqual(theme.toolBorder)
    } finally {
      setup.renderer.destroy()
    }
  })
})
