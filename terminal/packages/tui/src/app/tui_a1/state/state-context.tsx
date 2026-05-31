/** @jsxImportSource @opentui/solid */
import { createContext, createMemo, onCleanup, useContext, type ParentProps } from "solid-js"
import {
  attachSelectionToMessages,
  createRuntimePlaceholderMessages,
  defaultTuiA1Selection,
  initialMessages,
  type TuiA1Message,
  type TuiA1Selection,
} from "../data"
import { TuiA1StateGraph } from "../graph"
import { resolveInitialRoute, type Route } from "../route/route"
import type { PromptInfo } from "../features/composer/model/prompt-info"

type TuiA1StateContextValue = {
  stateGraph: TuiA1StateGraph
}

const TuiA1StateContext = createContext<TuiA1StateContextValue>()

export function TuiA1StateProvider(
  props: ParentProps<{
    runtimeEnabled: boolean
    initialMessages?: TuiA1Message[]
    selection?: TuiA1Selection
    sessionID?: string
    initialPrompt?: string
  }>,
) {
  const initialSelection = createMemo(() => props.selection ?? defaultTuiA1Selection)
  const initialRoute = createMemo<Route>(() => {
    if (props.sessionID) return { type: "session", sessionID: props.sessionID }
    return resolveInitialRoute()
  })
  const initialComposer = createMemo<PromptInfo>(() => {
    const routePrompt = initialRoute().initialPrompt
    if (routePrompt) return routePrompt
    if (props.initialPrompt?.trim()) return { input: props.initialPrompt, parts: [] }
    return { input: "", parts: [] }
  })
  const graph = new TuiA1StateGraph({
    composer: initialComposer(),
    initialMessages: props.runtimeEnabled
      ? createRuntimePlaceholderMessages(initialSelection(), true)
      : attachSelectionToMessages(props.initialMessages ?? initialMessages, initialSelection()),
    route: initialRoute(),
    selection: initialSelection(),
    sessionID: props.sessionID,
  })

  onCleanup(() => {
    graph.dispose()
  })

  return (
    <TuiA1StateContext.Provider value={{ stateGraph: graph }}>{props.children}</TuiA1StateContext.Provider>
  )
}

export function useTuiA1State() {
  const value = useContext(TuiA1StateContext)
  if (!value) {
    throw new Error("useTuiA1State must be used within TuiA1StateProvider")
  }
  return value
}

export function useTuiA1StateOptional() {
  return useContext(TuiA1StateContext)
}
