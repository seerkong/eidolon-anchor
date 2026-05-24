import { createMemo, createSignal, type Component, For, Match, Show, Switch } from "solid-js"
import path from "path"
import { Locale } from "../../../../../support/util/locale"
import { TodoItem } from "../../../../../ui/primitives/todo-item"
import { Filesystem } from "../../../../../support/util/filesystem"
import { Global } from "../../../../../support/global"
import stripAnsi from "strip-ansi"
import { useSessionContext } from "./session-context"
import { tuiA1Theme as theme } from "../../../theme"
import { generateSyntax } from "../../../../../providers/theme/syntax"
import {
  BlockTool,
  filetype,
  formatInput,
  InlineTool,
  normalizePath,
  type ToolCardProps,
} from "./tool-chrome"

const syntax = generateSyntax(theme)
const TOOL_TEXT_PREVIEW_LINES = 24
const TOOL_TEXT_PREVIEW_CHARS = 4000

function getDelegateType(input: Record<string, unknown>): string {
  return String(input.delegate_type ?? "unknown")
}

type ToolDiagnostic = {
  severity?: number
  message: string
  range: {
    start: {
      line: number
      character: number
    }
  }
}

export function GenericTool(props: ToolCardProps<any>) {
  return (
    <InlineTool icon="⚙" pending="Writing command..." complete={true} part={props.part}>
      {props.tool} {formatInput(props.input)}
    </InlineTool>
  )
}

function useExpandableTextPreview(raw: () => string, options?: { maxLines?: number; maxChars?: number }) {
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = options?.maxLines ?? TOOL_TEXT_PREVIEW_LINES
  const maxChars = options?.maxChars ?? TOOL_TEXT_PREVIEW_CHARS
  const normalized = createMemo(() => stripAnsi(String(raw() ?? "")).trim())
  const preview = createMemo(() => {
    const text = normalized()
    const lines = text.split("\n")
    let limited = lines.slice(0, maxLines).join("\n")
    let truncated = lines.length > maxLines
    if (limited.length > maxChars) {
      limited = limited.slice(0, maxChars)
      truncated = true
    }
    return {
      text: expanded() || !truncated ? text : `${limited}\n...`,
      truncated,
      expanded: expanded(),
    }
  })

  return {
    preview,
    toggle: () => setExpanded((prev) => !prev),
  }
}

function BashCard(props: ToolCardProps<any>) {
  const ctx = useSessionContext()
  const output = createMemo(() => stripAnsi(props.metadata.output?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const overflow = createMemo(() => lines().length > 10)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, 10), "…"].join("\n")
  })
  const workdirDisplay = createMemo(() => {
    const workdir = props.input.workdir
    if (!workdir || workdir === ".") return undefined
    const base = ctx.directory
    if (!base) return undefined
    const absolute = path.resolve(base, workdir)
    if (absolute === base) return undefined
    const home = Global.Path.home
    if (!home) return absolute
    const match = absolute === home || absolute.startsWith(home + path.sep)
    return match ? absolute.replace(home, "~") : absolute
  })
  const title = createMemo(() => {
    const desc = props.input.description ?? "Shell"
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })
  return (
    <Switch>
      <Match when={props.metadata.output !== undefined}>
        <BlockTool title={title()} part={props.part} onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}>
          <box gap={1}>
            <text fg={theme.text}>$ {props.input.command}</text>
            <text fg={theme.text}>{limited()}</text>
            <Show when={overflow()}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={props.input.command} part={props.part}>
          {props.input.command}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function WriteCard(props: ToolCardProps<any>) {
  const contentPreview = useExpandableTextPreview(() => props.input.content ?? "")
  const shouldShowBlock = createMemo(() => props.part.state.status === "completed" || props.metadata.diagnostics !== undefined)
  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    return props.metadata.diagnostics?.[filePath] ?? []
  })
  return (
    <Switch>
      <Match when={shouldShowBlock()}>
        <BlockTool
          title={`# Wrote ${normalizePath(props.input.filePath!)}`}
          part={props.part}
          onClick={contentPreview.preview().truncated ? contentPreview.toggle : undefined}
        >
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(props.input.filePath!)}
              syntaxStyle={syntax}
              content={contentPreview.preview().text}
            />
          </line_number>
          <Show when={contentPreview.preview().truncated}>
            <text fg={theme.textMuted}>{contentPreview.preview().expanded ? "Click to collapse" : "Click to expand"}</text>
          </Show>
          <Show when={diagnostics().length}>
            <For each={diagnostics()}>
              {(diagnostic) => (
                <text fg={theme.error}>
                  Error [{diagnostic.range.start.line}:{diagnostic.range.start.character}]: {diagnostic.message}
                </text>
              )}
            </For>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing write..." complete={props.input.filePath} part={props.part}>
          Write {normalizePath(props.input.filePath!)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function GlobCard(props: ToolCardProps<any>) {
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={props.input.pattern} part={props.part}>
      Glob "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.count}>({props.metadata.count} matches)</Show>
    </InlineTool>
  )
}

function ReadCard(props: ToolCardProps<any>) {
  return (
    <InlineTool icon="→" pending="Reading file..." complete={props.input.filePath} part={props.part}>
      Read {normalizePath(props.input.filePath!)} {formatInput(props.input, ["filePath"])}
    </InlineTool>
  )
}

function GrepCard(props: ToolCardProps<any>) {
  return (
    <InlineTool icon="✱" pending="Searching content..." complete={props.input.pattern} part={props.part}>
      Grep "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.matches}>({props.metadata.matches} matches)</Show>
    </InlineTool>
  )
}

function ListCard(props: ToolCardProps<any>) {
  const dir = createMemo(() => (props.input.path ? normalizePath(props.input.path) : ""))
  return (
    <InlineTool icon="→" pending="Listing directory..." complete={props.input.path !== undefined} part={props.part}>
      List {dir()}
    </InlineTool>
  )
}

function WebFetchCard(props: ToolCardProps<any>) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={(props.input as any).url} part={props.part}>
      WebFetch {(props.input as any).url}
    </InlineTool>
  )
}

function CodeSearchCard(props: ToolCardProps<any>) {
  const input = props.input as any
  const metadata = props.metadata as any
  return (
    <InlineTool icon="◇" pending="Searching code..." complete={input.query} part={props.part}>
      Exa Code Search "{input.query}" <Show when={metadata.results}>({metadata.results} results)</Show>
    </InlineTool>
  )
}

function WebSearchCard(props: ToolCardProps<any>) {
  const input = props.input as any
  const metadata = props.metadata as any
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={input.query} part={props.part}>
      Exa Web Search "{input.query}" <Show when={metadata.numResults}>({metadata.numResults} results)</Show>
    </InlineTool>
  )
}

function TaskCard(props: ToolCardProps<any>) {
  const ctx = useSessionContext()
  const current = createMemo(() => {
    const summary = props.metadata.summary
    if (!summary) return undefined
    for (let i = summary.length - 1; i >= 0; i -= 1) {
      const entry = summary[i]
      if (entry?.state.status !== "pending") return entry
    }
    return undefined
  })
  const delegateType = createMemo(() => getDelegateType(props.input as Record<string, unknown>))
  const color = createMemo(() => ctx.agentColor(delegateType()))
  return (
    <Switch>
      <Match when={props.metadata.summary?.length}>
        <BlockTool
          title={`# ${Locale.titlecase(delegateType())} Task`}
          onClick={props.metadata.sessionId ? () => ctx.navigateToSession?.(props.metadata.sessionId!) : undefined}
          part={props.part}
        >
          <box>
            <text style={{ fg: theme.textMuted }}>
              {props.input.description} ({props.metadata.summary?.length} toolcalls)
            </text>
            <Show when={current()}>
              <text style={{ fg: current()!.state.status === "error" ? theme.error : theme.textMuted }}>
                └ {Locale.titlecase(current()!.tool)} {current()!.state.status === "completed" ? current()!.state.title : ""}
              </text>
            </Show>
          </box>
          <text fg={theme.text}>
            {ctx.keybindLabel("session_child_cycle")}
            <span style={{ fg: theme.textMuted }}> view delegated tasks</span>
          </text>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="◉" iconColor={color()} pending="Delegating..." complete={delegateType() || props.input.description} part={props.part}>
          <span style={{ fg: theme.text }}>{Locale.titlecase(delegateType())}</span> Task "{props.input.description}"
        </InlineTool>
      </Match>
    </Switch>
  )
}

function EditCard(props: ToolCardProps<any>) {
  const ctx = useSessionContext()
  const view = createMemo(() => {
    return ctx.width > 120 ? "split" : "unified"
  })
  const ft = createMemo(() => filetype(props.input.filePath))
  const diffContent = createMemo(() => props.metadata.diff)
  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    const arr = props.metadata.diagnostics?.[filePath] ?? []
    return (arr as ToolDiagnostic[]).filter((x) => x.severity === 1).slice(0, 3)
  })
  return (
    <Switch>
      <Match when={props.metadata.diff !== undefined}>
        <BlockTool title={`← Edit ${normalizePath(props.input.filePath!)}`} part={props.part}>
          <box paddingLeft={1}>
            <diff
              diff={diffContent()}
              view={view()}
              filetype={ft()}
              syntaxStyle={syntax}
              showLineNumbers={true}
              width="100%"
              wrapMode={ctx.diffWrapMode()}
              fg={theme.text}
              addedBg={theme.diffAddedBg}
              removedBg={theme.diffRemovedBg}
              contextBg={theme.diffContextBg}
              addedSignColor={theme.diffHighlightAdded}
              removedSignColor={theme.diffHighlightRemoved}
              lineNumberFg={theme.diffLineNumber}
              lineNumberBg={theme.diffContextBg}
              addedLineNumberBg={theme.diffAddedLineNumberBg}
              removedLineNumberBg={theme.diffRemovedLineNumberBg}
            />
          </box>
          <Show when={diagnostics().length}>
            <box>
              <For each={diagnostics()}>
                {(diagnostic) => (
                  <text fg={theme.error}>
                    Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
                  </text>
                )}
              </For>
            </box>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit..." complete={props.input.filePath} part={props.part}>
          Edit {normalizePath(props.input.filePath!)} {formatInput({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function PatchCard(props: ToolCardProps<any>) {
  const ctx = useSessionContext()
  const view = createMemo(() => (ctx.width > 120 ? "split" : "unified"))
  const diffContent = createMemo(() => props.metadata.diff)
  return (
    <Switch>
      <Match when={props.metadata.diff !== undefined}>
        <BlockTool title="# Patch" part={props.part}>
          <box paddingLeft={1}>
            <diff
              diff={diffContent()}
              view={view()}
              filetype={props.metadata.filePath ? filetype(props.metadata.filePath) : undefined}
              syntaxStyle={syntax}
              showLineNumbers={true}
              width="100%"
              wrapMode={ctx.diffWrapMode()}
              fg={theme.text}
              addedBg={theme.diffAddedBg}
              removedBg={theme.diffRemovedBg}
              contextBg={theme.diffContextBg}
              addedSignColor={theme.diffHighlightAdded}
              removedSignColor={theme.diffHighlightRemoved}
              lineNumberFg={theme.diffLineNumber}
              lineNumberBg={theme.diffContextBg}
              addedLineNumberBg={theme.diffAddedLineNumberBg}
              removedLineNumberBg={theme.diffRemovedLineNumberBg}
            />
          </box>
          <Show when={props.metadata.output}>
            <box>
              <text fg={theme.text}>{props.metadata.output?.trim()}</text>
            </box>
          </Show>
        </BlockTool>
      </Match>
      <Match when={props.output !== undefined || props.metadata.output !== undefined}>
        <BlockTool title="# Patch" part={props.part}>
          <box>
            <text fg={theme.text}>{String(props.metadata.output ?? props.output ?? "").trim()}</text>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing patch..." complete={false} part={props.part}>
          Patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TaskTreeWriteCard(props: ToolCardProps<any>) {
  const tasks = createMemo(() => {
    const raw = props.input as { tasks?: Array<{ status: string; content: string }> }
    return Array.isArray(raw.tasks) ? raw.tasks : []
  })
  return (
    <Switch>
      <Match when={props.output !== undefined}>
        <BlockTool title="# Task Tree" part={props.part}>
          <box>
            <text>{props.output}</text>
          </box>
        </BlockTool>
      </Match>
      <Match when={tasks().length > 0}>
        <BlockTool title="# Task Tree" part={props.part}>
          <box>
            <For each={tasks()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="Updating task tree..." complete={false} part={props.part}>
          Updating task tree...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TaskTreeReadCard(props: ToolCardProps<any>) {
  return (
    <Switch>
      <Match when={props.output !== undefined}>
        <BlockTool title="# Task Tree" part={props.part}>
          <box>
            <text>{props.output}</text>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="Reading task tree..." complete={false} part={props.part}>
          Reading task tree...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function QuestionCard(props: ToolCardProps<any>) {
  const count = createMemo(() => props.input.questions?.length ?? 0)
  function format(answer?: string[]) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }
  return (
    <Switch>
      <Match when={props.metadata.answers}>
        <BlockTool title="# Questions" part={props.part}>
          <box>
            <For each={props.input.questions ?? []}>
              {(q, i) => (
                <box flexDirection="row" gap={1}>
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(props.metadata.answers?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

export const TOOL_CARD_REGISTRY: Record<string, Component<ToolCardProps<any>>> = {
  bash: BashCard,
  glob: GlobCard,
  read: ReadCard,
  grep: GrepCard,
  list: ListCard,
  webfetch: WebFetchCard,
  codesearch: CodeSearchCard,
  websearch: WebSearchCard,
  write: WriteCard,
  edit: EditCard,
  multiedit: EditCard,
  task: TaskCard,
  patch: PatchCard,
  apply_patch: PatchCard,
  tasktreewrite: TaskTreeWriteCard,
  tasktreeread: TaskTreeReadCard,
  question: QuestionCard,
}
