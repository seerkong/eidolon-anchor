import type { TextareaRenderable, KeyBinding } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { createMemo, createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Clipboard } from "../../../../support/util/clipboard"
import { useKeybind } from "../../../../providers/keybind"
import { tuiA1Theme as theme } from "../../theme"
import { useDialog } from "../../../../ui/dialog/context"
import { DialogSelect } from "../../../../ui/dialog/select"
import { useLocal } from "../../state/local-context"
import { formatAgentOptionDescription, sortAgentsByCurrent } from "../../system/agent/agent-option"
import { usePromptHistory } from "./model/prompt-history"
import { useTuiA1StateOptional } from "../../state/state-context"
import { clonePromptInfo, normalizePromptInfoForSubmit } from "./model/prompt-parts"
import { restoreExtmarksFromParts, syncExtmarksWithPromptParts, type ExtmarkStore } from "./model/extmarks"
import {
  buildPromptWithInsertedAgentPart,
  buildPromptWithInsertedFilePart,
  formatFilePartVirtualText,
  pasteImage,
  pasteText,
} from "./model/paste"
import type { PromptInfo } from "./model/prompt-info"
import { DialogWorkspaceFilePicker } from "./file-picker-dialog"

const composerBindings: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "linefeed", shift: true, action: "newline" },
]

function safeUseDialog() {
  try {
    return useDialog()
  } catch {
    return {
      clear() {},
      replace() {},
      stack: [],
    } as unknown as ReturnType<typeof useDialog>
  }
}

function safeUseLocal() {
  try {
    return useLocal()
  } catch {
    return {
      agent: {
        list: () => [],
      },
    } as unknown as ReturnType<typeof useLocal>
  }
}

function safeUsePromptHistory() {
  try {
    return usePromptHistory()
  } catch {
    return {
      append() {},
      move() {
        return undefined
      },
    } as ReturnType<typeof usePromptHistory>
  }
}

function safeUseKeybind() {
  try {
    return useKeybind()
  } catch {
    return {
      match() {
        return false
      },
      print() {
        return ""
      },
    } as Pick<ReturnType<typeof useKeybind>, "match" | "print">
  }
}

export function Composer(props: {
  busy: boolean
  blocked?: boolean
  blockLabel?: string
  directory: string
  focused?: boolean
  selectionLabel: string
  onHistoryScrollRequest?: (event: {
    scroll?: { direction?: string }
    preventDefault: () => void
    stopPropagation: () => void
  }) => void
  onSubmit: (value: PromptInfo, clear: () => void) => void
  onReady?: (textarea: TextareaRenderable) => void
  onFocusRequest?: () => void
}) {
  let textarea: TextareaRenderable | undefined
  let promptPartTypeId = 1
  const renderer = useRenderer()
  const dialog = safeUseDialog()
  const keybind = safeUseKeybind()
  const local = safeUseLocal()
  const promptHistory = safeUsePromptHistory()
  const stateContext = useTuiA1StateOptional()
  const stateGraph = stateContext?.stateGraph
  const initialPrompt = createMemo(() =>
    stateGraph ? clonePromptInfo(stateGraph.graph.get<PromptInfo>("composer")) : { input: "", parts: [] },
  )
  const [value, setValue] = createSignal(initialPrompt().input)
  const [store, setStore] = createStore<ExtmarkStore>({
    prompt: initialPrompt(),
    extmarkToPartIndex: new Map(),
  })
  const focused = () => props.focused ?? true
  const composerPlaceholder = () => (props.blocked ? "Resolve approval to continue" : "Type a prompt")
  const routeHistoryScroll = (event: {
    scroll?: { direction?: string }
    preventDefault: () => void
    stopPropagation: () => void
  }) => {
    if (focused()) return
    props.onHistoryScrollRequest?.(event)
  }
  const previewText = createMemo(() => {
    const lines = (value() || composerPlaceholder()).split("\n")
    if (lines.length <= 4) return lines.join("\n")
    return [...lines.slice(0, 3), `${lines[3]} …`].join("\n")
  })
  const promptPartSummary = createMemo(() => {
    const fileCount = store.prompt.parts.filter((part) => part.type === "file").length
    const agentCount = store.prompt.parts.filter((part) => part.type === "agent").length
    const textCount = store.prompt.parts.filter((part) => part.type === "text").length
    const parts: string[] = []
    if (fileCount > 0) parts.push(`${fileCount} file${fileCount > 1 ? "s" : ""}`)
    if (agentCount > 0) parts.push(`${agentCount} mention${agentCount > 1 ? "s" : ""}`)
    if (textCount > 0) parts.push(`${textCount} paste${textCount > 1 ? "s" : ""}`)
    return parts.join(" · ")
  })

  const liveTextarea = () => {
    const current = textarea as (TextareaRenderable & { isDestroyed?: boolean }) | undefined
    if (!current || current.isDestroyed) return undefined
    return current
  }
  const currentTextareaText = () => liveTextarea()?.plainText ?? store.prompt.input

  const withLiveTextarea = (run: (input: TextareaRenderable) => void, attempts = 12) => {
    const current = liveTextarea()
    if (current) {
      run(current)
      return
    }
    if (attempts <= 0) return
    setTimeout(() => withLiveTextarea(run, attempts - 1), 1)
  }

  const syncGraphComposer = () => {
    const nextPrompt = clonePromptInfo({
      ...store.prompt,
      input: currentTextareaText(),
    })
    stateGraph?.setComposer(nextPrompt)
    setValue(nextPrompt.input)
  }

  const restorePrompt = (prompt: PromptInfo) => {
    const nextPrompt = clonePromptInfo(prompt)
    textarea?.setText(nextPrompt.input)
    setStore({
      prompt: nextPrompt,
      extmarkToPartIndex: new Map(),
    })
    if (textarea) {
      restoreExtmarksFromParts(
        textarea,
        nextPrompt.parts,
        0,
        0,
        0,
        promptPartTypeId,
        setStore,
      )
    }
    stateGraph?.setComposer(nextPrompt)
    setValue(nextPrompt.input)
    textarea?.focus()
  }

  const clearPrompt = () => {
    textarea?.setText("")
    textarea?.extmarks.clear()
    const emptyPrompt = { input: "", parts: [] as PromptInfo["parts"] }
    setStore({
      prompt: emptyPrompt,
      extmarkToPartIndex: new Map(),
    })
    stateGraph?.setComposer(emptyPrompt)
    setValue("")
    textarea?.focus()
  }

  const buildSubmitPrompt = () => {
    return normalizePromptInfoForSubmit(
      {
        ...store.prompt,
        input: currentTextareaText(),
      },
      local.agent.list().map((agent) => agent.name),
    )
  }

  const openAgentPicker = () => {
    const insertOffset = liveTextarea()?.visualCursor.offset ?? store.prompt.input.length
    dialog.replace(() => (
      <DialogSelect
        title="Insert mention"
        placeholder="Search agents"
        options={sortAgentsByCurrent(local.agent.list(), local.agent.current().name).map((agent) => ({
          title: agent.name,
          value: agent.name,
          description: formatAgentOptionDescription(agent),
        }))}
        onSelect={(option) => {
          const nextPrompt = buildPromptWithInsertedAgentPart(
            {
              ...clonePromptInfo(store.prompt),
              input: currentTextareaText(),
            },
            option.value,
            insertOffset,
          )
          const insertedCursorOffset = insertOffset + option.value.length + 2
          setStore({
            prompt: nextPrompt,
            extmarkToPartIndex: new Map(),
          })
          stateGraph?.setComposer(nextPrompt)
          setValue(nextPrompt.input)
          withLiveTextarea((input) => {
            input.setText(nextPrompt.input)
            restoreExtmarksFromParts(input, nextPrompt.parts, 0, 0, 0, promptPartTypeId, setStore)
            input.cursorOffset = Math.min(nextPrompt.input.length, insertedCursorOffset)
            input.focus()
          })
        }}
      />
    ))
  }

  const openFilePicker = () => {
    const insertOffset = liveTextarea()?.visualCursor.offset ?? store.prompt.input.length
    dialog.replace(() => (
      <DialogWorkspaceFilePicker
        directory={props.directory}
        onSelect={(file) => {
          const insertedCursorOffset =
            insertOffset +
            formatFilePartVirtualText({
              path: file.absolutePath,
              filename: file.relativePath,
            }).length +
            1
          const nextPrompt = buildPromptWithInsertedFilePart(
            {
              ...clonePromptInfo(store.prompt),
              input: currentTextareaText(),
            },
            {
              path: file.absolutePath,
              filename: file.relativePath,
              mime: "text/plain",
            },
            insertOffset,
          )
          setStore({
            prompt: nextPrompt,
            extmarkToPartIndex: new Map(),
          })
          stateGraph?.setComposer(nextPrompt)
          setValue(nextPrompt.input)
          withLiveTextarea((input) => {
            input.setText(nextPrompt.input)
            restoreExtmarksFromParts(input, nextPrompt.parts, 0, 0, 0, promptPartTypeId, setStore)
            input.cursorOffset = Math.min(nextPrompt.input.length, insertedCursorOffset)
            input.focus()
          })
        }}
      />
    ))
  }

  const pasteFromClipboard = async () => {
    if (!textarea) return
    const content = await Clipboard.read()
    if (!content) return
    if (content.mime.startsWith("image/")) {
      await pasteImage(
        textarea,
        {
          content: content.data,
          filename: "clipboard-image.png",
          mime: content.mime,
        },
        undefined,
        promptPartTypeId,
        setStore,
      )
    } else {
      pasteText(textarea, content.data, content.data, undefined, promptPartTypeId, setStore)
    }
    syncGraphComposer()
  }

  useKeyboard((event) => {
    if (!focused() || !textarea || props.busy || props.blocked) return
    if (event.defaultPrevented) return

    if ((event as { alt?: boolean }).alt && event.name === "up") {
      const previous = promptHistory.move(-1, clonePromptInfo({
        ...store.prompt,
        input: textarea.plainText,
      }))
      if (previous) {
        restorePrompt(previous)
      }
      event.preventDefault()
      return
    }

    if ((event as { alt?: boolean }).alt && event.name === "down") {
      const next = promptHistory.move(1, clonePromptInfo({
        ...store.prompt,
        input: textarea.plainText,
      }))
      if (next) {
        restorePrompt(next)
      }
      event.preventDefault()
      return
    }

    if (event.ctrl && event.name === "g") {
      event.preventDefault()
      openAgentPicker()
      return
    }

    if (event.ctrl && event.name === "o") {
      event.preventDefault()
      openFilePicker()
      return
    }

    if (keybind.match("input_clear", event)) {
      event.preventDefault()
      clearPrompt()
      return
    }

    if (event.ctrl && event.name === "v") {
      event.preventDefault()
      void pasteFromClipboard()
    }
  })

  return (
    <box
      flexShrink={0}
      flexDirection="column"
      paddingTop={0}
      paddingBottom={0}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={() => {
        props.onFocusRequest?.()
        textarea?.focus()
      }}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onFocusRequest?.()
        textarea?.focus()
      }}
      onMouseScroll={routeHistoryScroll}
    >
      <box flexDirection="row" onMouseScroll={routeHistoryScroll}>
        <text fg={focused() ? theme.inputBorder : theme.textMuted}>{props.selectionLabel}</text>
        <box flexGrow={1} />
        <text fg={props.busy ? theme.warning : theme.textMuted}>
          {props.blocked
            ? props.blockLabel ?? "approval required before submit"
            : props.busy
              ? "streaming local reply"
              : `shift+enter newline · ctrl+g mention · ctrl+o file · ${
                  keybind.print("input_clear") || "ctrl+shift+l"
                } clear`}
        </text>
      </box>
      <Show when={store.prompt.parts.length > 0}>
        <text fg={theme.secondary} wrapMode="char" onMouseScroll={routeHistoryScroll}>
          parts {promptPartSummary()}
        </text>
      </Show>

      <Show
        when={focused()}
        fallback={
          <box
            minHeight={1}
            paddingTop={0}
            paddingBottom={0}
            backgroundColor={theme.panelGlow}
            onMouseScroll={routeHistoryScroll}
          >
            <text fg={value().length > 0 ? theme.text : theme.textMuted} wrapMode="word" onMouseScroll={routeHistoryScroll}>
              {previewText()}
            </text>
          </box>
        }
      >
        <box minHeight={2} backgroundColor={theme.panelGlow}>
          <textarea
            ref={(value: TextareaRenderable) => {
              textarea = value
              promptPartTypeId =
                value.extmarks.getTypeId("tui_a1-prompt-part") ?? value.extmarks.registerType("tui_a1-prompt-part")
              if (store.prompt.input) {
                value.setText(store.prompt.input)
                restoreExtmarksFromParts(
                  value,
                  store.prompt.parts,
                  0,
                  0,
                  0,
                  promptPartTypeId,
                  setStore,
                )
              }
              props.onReady?.(value)
            }}
            focused={focused()}
            minHeight={2}
            maxHeight={4}
            initialValue={value()}
            placeholder={composerPlaceholder()}
            keyBindings={composerBindings}
            textColor={theme.text}
            focusedTextColor={theme.text}
            placeholderColor={theme.textMuted}
            backgroundColor={theme.panelGlow}
            focusedBackgroundColor={theme.panelGlow}
            onContentChange={() => {
              syncExtmarksWithPromptParts(textarea!, promptPartTypeId, setStore)
              setStore("prompt", "input", textarea?.plainText ?? "")
              syncGraphComposer()
            }}
            onSubmit={() => {
              if (props.busy || props.blocked) return
              const prompt = buildSubmitPrompt()
              if (!prompt.input.trim()) return
              promptHistory.append(prompt)
              props.onSubmit(prompt, clearPrompt)
            }}
          />
        </box>
      </Show>
      <text fg={value().length > 0 ? theme.secondary : theme.textMuted} onMouseScroll={routeHistoryScroll}>
        {value().length} chars · {store.prompt.parts.length} parts
      </text>
    </box>
  )
}
