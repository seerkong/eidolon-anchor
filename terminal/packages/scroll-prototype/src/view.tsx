import { SyntaxStyle, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, type JSX } from "@opentui/solid"
import { createOpenTuiScrollRuntime } from "depa-scroll-opentui-capsule"
import { ScrollWindowContent } from "depa-scroll-opentui-capsule/solid"
import type { ScrollConfig, ScrollRow } from "depa-scroll-contract"
import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createSyntheticSource, type DemoPayload, type RowRevision, type SourceFault, type SyntheticSource } from "./source"

export type DemoRuntime = ReturnType<typeof createOpenTuiScrollRuntime<DemoPayload>>
export interface RowContentProps {
  readonly row: ScrollRow<DemoPayload>
  readonly syntax: SyntaxStyle
  readonly toggle: () => void
}
export interface PrototypeHandle {
  readonly runtime: DemoRuntime
  readonly scrollbox: ScrollBoxRenderable
  readonly source: () => SyntheticSource
  readonly mountedNodes: () => readonly BoxRenderable[]
  readonly append: (jump?: boolean) => ScrollRow<DemoPayload>
  readonly revise: (order: number, change: RowRevision) => ScrollRow<DemoPayload>
  readonly switchSource: (source: SyntheticSource) => void
  readonly setComposerHeight: (height: number) => void
  readonly inject: (fault: SourceFault) => void
}
export interface PrototypeProps {
  readonly source: SyntheticSource
  readonly config?: Partial<ScrollConfig>
  readonly composerHeight?: number
  readonly interactive?: boolean
  readonly renderRow?: (props: RowContentProps) => JSX.Element
  readonly onReady?: (handle: PrototypeHandle) => void
}

export function LogRowContent(props: RowContentProps): JSX.Element {
  return <text width="100%" wrapMode="word" content={props.row.payload.body} />
}

export function ChatRowContent(props: RowContentProps): JSX.Element {
  return <Switch>
    <Match when={props.row.payload.kind === "markdown"}>
      <markdown width="100%" syntaxStyle={props.syntax} content={props.row.payload.body}
        streaming={!props.row.payload.completed} />
    </Match>
    <Match when={props.row.payload.kind === "code"}>
      <code width="100%" syntaxStyle={props.syntax} content={props.row.payload.body} filetype="typescript"
        drawUnstyledText={true} streaming={!props.row.payload.completed} />
    </Match>
    <Match when={props.row.payload.kind === "tool"}>
      <box width="100%" flexDirection="column" onMouseDown={props.toggle}>
        <text fg="#94d2bd" content={`$ deterministic-tool --row ${props.row.order} [${props.row.payload.completed ? "complete" : "streaming"}]`} />
        <Show when={props.row.payload.expanded} fallback={<text content={`… collapsed · END-${props.row.order}`} />}>
          <text width="100%" wrapMode="word" content={props.row.payload.body} />
        </Show>
      </box>
    </Match>
  </Switch>
}

function DemoCard(props: {
  readonly row: () => ScrollRow<DemoPayload>
  readonly syntax: SyntaxStyle
  readonly renderRow?: PrototypeProps["renderRow"]
  readonly revise: PrototypeHandle["revise"]
}): JSX.Element {
  const row = props.row
  const toggle = () => {
    const current = row()
    if (typeof current.order !== "number") throw new Error("Synthetic source requires scalar order")
    props.revise(current.order, { expanded: !current.payload.expanded })
  }
  const content = () => props.renderRow ?? (row().payload.kind === "log" ? LogRowContent : ChatRowContent)
  return <box width="100%" border={true} borderColor="#496174" flexShrink={0} flexDirection="column">
      <text fg="#e9c46a" content={`${row().payload.title} · revision ${row().contentRevision}`} />
      {content()({ get row() { return row() }, syntax: props.syntax, toggle })}
  </box>
}

export function ScrollPrototype(props: PrototypeProps): JSX.Element {
  const renderer = useRenderer()
  const [source, setSource] = createSignal(props.source)
  const [runtime, setRuntime] = createSignal<DemoRuntime>()
  const [composerHeight, setComposerHeight] = createSignal(props.composerHeight ?? 6)
  const [armedFault, setArmedFault] = createSignal("none")
  const [notice, setNotice] = createSignal("")
  const nodes = new Set<BoxRenderable>()
  const syntax = SyntaxStyle.fromTheme([
    { scope: ["default"], style: { foreground: "#d7e3ef" } },
    { scope: ["keyword", "markup.heading"], style: { foreground: "#e9c46a", bold: true } },
    { scope: ["string", "markup.link"], style: { foreground: "#94d2bd" } },
    { scope: ["comment"], style: { foreground: "#8394a5" } },
  ])
  let scrollbox!: ScrollBoxRenderable
  let handle: PrototypeHandle | undefined
  let nextEpoch = props.source.identity.sourceEpoch
  let streamLines = 0
  let faultIndex = 0
  const faults: SourceFault[] = [
    { type: "timeout" }, { type: "reject" }, { type: "stale" }, { type: "budget" },
    { type: "nonprogress" }, { type: "empty" }, { type: "controlled-delay" },
  ]
  onMount(() => {
    const owner = createOpenTuiScrollRuntime<DemoPayload>({ renderer, scrollbox,
      loadPage: (request, signal) => { setArmedFault("none"); return source().loadPage(request, signal) } },
      { identity: source().identity }, props.config)
    setRuntime(owner)
    handle = {
      runtime: owner, scrollbox, source,
      mountedNodes: () => [...nodes],
      append: (jump = false) => {
        const row = source().append()
        owner.dispatch({ type: "live", identity: source().identity, rows: [row] })
        if (jump) owner.dispatch({ type: "jump-to-latest" })
        return row
      },
      revise: (order, change) => {
        const row = source().revise(order, change)
        owner.dispatch({ type: "live", identity: source().identity, rows: [row] })
        return row
      },
      switchSource: next => {
        setSource(next)
        owner.dispatch({ type: "switch-source", identity: next.identity })
      },
      setComposerHeight: height => setComposerHeight(Math.max(3, Math.min(12, Math.floor(height)))),
      inject: fault => { source().inject(fault); setArmedFault(fault.type) },
    }
    if (props.interactive !== false) scrollbox.focus()
    props.onReady?.(handle)
    onCleanup(() => owner.dispose())
  })
  onCleanup(() => syntax.destroy())

  useKeyboard(event => {
    if (props.interactive === false || !handle) return
    const owner = handle.runtime
    try {
      if (event.name === "end") { event.preventDefault(); owner.dispatch({ type: "jump-to-latest" }) }
      else if (event.name === "return") { event.preventDefault(); handle.append(true) }
      else if (event.name === "l") handle.append()
      else if (event.name === "u") handle.revise(source().stats().count - 1, { streamLines: ++streamLines, completed: false })
      else if (event.name === "v") handle.revise(source().stats().count - 1, { completed: true })
      else if (event.name === "x") {
        const row = owner.window().rows.find(item => item.row.payload.kind === "tool")?.row
        if (row) {
          if (typeof row.order !== "number") throw new Error("Synthetic source requires scalar order")
          handle.revise(row.order, { expanded: !row.payload.expanded })
        }
      }
      else if (event.name === "r") owner.dispatch({ type: "retry" })
      else if (event.name === "escape") owner.dispatch({ type: "cancel" })
      else if (event.name === "f") handle.inject(faults[faultIndex++ % faults.length])
      else if (event.name === "d") source().release()
      else if (event.name === "[") owner.dispatch({ type: "request-page", direction: "earlier" })
      else if (event.name === "]") owner.dispatch({ type: "request-page", direction: "later" })
      else if (event.name === "c") handle.setComposerHeight(composerHeight() === 6 ? 10 : 6)
      else if (event.name === "t" || event.name === "a") {
        const current = source()
        handle.switchSource(createSyntheticSource({
          identity: { ...current.identity, sourceEpoch: ++nextEpoch,
            actorId: event.name === "a" ? `actor-${nextEpoch}` : current.identity.actorId },
          shape: event.name === "t" ? (current.shape === "log" ? "chat" : "log") : current.shape,
          count: current.stats().count,
        }))
      }
      else if (event.name === "q") renderer.destroy()
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  })

  const status = () => {
    const state = runtime()?.state()
    if (!state) return "starting"
    return `${source().shape} · ${state.status} · ${state.intent.type} · unread ${state.unreadCount} · pages ${state.pages.length}/4 · mounted ${runtime()!.window().rows.length} · measured ${state.measurements.length}`
  }
  return <box width="100%" height="100%" flexDirection="column" backgroundColor="#101923">
    <text height={1} flexShrink={0} content="Scroll prototype · Home/PgUp/PgDn/wheel/drag native · End latest · t log/chat · a actor · q quit" />
    <text height={1} flexShrink={0} fg="#94d2bd" content={status()} />
    <scrollbox ref={scrollbox} id="prototype-scroll" width="100%" flexGrow={1} minHeight={0} scrollY={true}
      onMouseScroll={event => {
        if (event.scroll?.direction === "up") runtime()?.boundaryNavigation("earlier")
        if (event.scroll?.direction === "down") runtime()?.boundaryNavigation("later")
      }}
      onKeyDown={event => {
        if (["up", "pageup", "home"].includes(event.name)) runtime()?.boundaryNavigation("earlier")
        if (["down", "pagedown"].includes(event.name)) runtime()?.boundaryNavigation("later")
      }}
      stickyScroll={false} contentOptions={{ flexDirection: "column", gap: 0 }}>
      <Show when={runtime()}>{owner => <ScrollWindowContent runtime={owner()} rowPaddingTop={1}
        onMountRow={node => { nodes.add(node) }} onUnmountRow={node => { nodes.delete(node) }}>
        {row => <DemoCard row={row} syntax={syntax} renderRow={props.renderRow} revise={(order, change) => handle!.revise(order, change)} />}
      </ScrollWindowContent>}</Show>
    </scrollbox>
    <box id="prototype-composer" height={composerHeight()} minHeight={3} flexShrink={0} border={true} flexDirection="column">
      <text height={1} content="Enter send · l append · u stream · v finish · x tool · c composer · [/] pages" />
      <text height={1} content={`f next fault (${armedFault()}) · d release delay · r retry · Esc cancel`} />
      <text height={1} fg="#e9c46a" content={runtime()?.state().error?.message ?? notice()} />
      <text height={1} content={`trace: ${runtime()?.state().diagnostics.slice(-4).map(item => item.code).join(" | ") ?? ""}`} />
    </box>
  </box>
}
