/** @jsxImportSource @opentui/solid */
import type { KeyBinding, PasteEvent, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/solid"
import path from "path"
import { createMemo, createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Clipboard } from "../../../../support/util/clipboard"
import { useKeybind } from "../../../../providers/keybind"
import { tuiA1Theme as theme } from "../../theme"
import { useDialog } from "../../../../ui/dialog/context"
import { DialogSelect } from "../../../../ui/dialog/select"
import { useTextareaKeybindings } from "../../../../ui/primitives/textarea-keybindings"
import { useLocal } from "../../state/local-context"
import { formatAgentOptionDescription, sortAgentsByCurrent } from "../../system/agent/agent-option"
import { movePromptHistoryCursor, usePromptHistory, type PromptHistoryState } from "./model/prompt-history"
import { useTuiA1StateOptional } from "../../state/state-context"
import { clonePromptInfo, countCanonicalPromptParts, normalizePromptInfoForSubmit } from "./model/prompt-parts"
import {
  deleteAttachmentBlocksFromPrompt,
  restoreExtmarksFromParts,
  syncExtmarksWithPromptParts,
  type ExtmarkStore,
} from "./model/extmarks"
import {
  buildPromptWithInsertedAgentPart,
  insertAttachmentParts,
  parseAttachmentPathPaste,
  pasteText,
  type AttachmentPartInput,
} from "./model/paste"
import type { PromptInfo } from "./model/prompt-info"
import { DialogWorkspaceFilePicker } from "./file-picker-dialog"

const fallbackComposerBindings: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "linefeed", action: "newline" },
  { name: "return", shift: true, action: "newline" },
  { name: "linefeed", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
]

function safeUseTextareaKeybindings() {
  try {
    return useTextareaKeybindings()
  } catch {
    return () => fallbackComposerBindings
  }
}

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
  statusLabel?: string
  selectionLabel: string
  userInputHistory?: PromptInfo[]
  onHistoryScrollRequest?: (event: {
    scroll?: { direction?: string }
    preventDefault: () => void
    stopPropagation: () => void
  }) => void
  onSubmit: (value: PromptInfo, clear: () => void) => void | Promise<void>
  onReady?: (textarea: TextareaRenderable) => void
  onFocusRequest?: () => void
  isAttachmentFile?: (candidate: string) => boolean
}) {
  let textarea: TextareaRenderable | undefined
  let promptPartTypeId = 1
  const renderer = useRenderer()
  const dialog = safeUseDialog()
  const keybind = safeUseKeybind()
  const composerBindings = safeUseTextareaKeybindings()
  const local = safeUseLocal()
  const promptHistory = safeUsePromptHistory()
  const stateContext = useTuiA1StateOptional()
  const stateGraph = stateContext?.stateGraph
  const initialPrompt = createMemo(() =>
    stateGraph ? clonePromptInfo(stateGraph.graph.get<PromptInfo>("composer")) : { input: "", parts: [] },
  )
  const [value, setValue] = createSignal(initialPrompt().input)
  const [factHistoryState, setFactHistoryState] = createSignal<PromptHistoryState>({
    index: 0,
    history: [],
    draft: undefined,
  })
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
  const canonicalPartCount = createMemo(() => countCanonicalPromptParts(store.prompt))

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
    if (textarea) textarea.cursorOffset = textarea.plainText.length
    textarea?.focus()
  }

  const applyPrompt = (prompt: PromptInfo, cursorOffset: number) => {
    const nextPrompt = clonePromptInfo(prompt)
    setStore({
      prompt: nextPrompt,
      extmarkToPartIndex: new Map(),
    })
    stateGraph?.setComposer(nextPrompt)
    setValue(nextPrompt.input)
    withLiveTextarea((input) => {
      input.setText(nextPrompt.input)
      restoreExtmarksFromParts(input, nextPrompt.parts, 0, 0, 0, promptPartTypeId, setStore)
      input.cursorOffset = Math.min(nextPrompt.input.length, Math.max(0, cursorOffset))
      input.focus()
    })
  }

  const insertAttachments = (files: AttachmentPartInput[], offset: number) => {
    const nextPrompt = insertAttachmentParts(
      {
        ...clonePromptInfo(store.prompt),
        input: currentTextareaText(),
      },
      files,
      offset,
    )
    const insertedLength = nextPrompt.input.length - currentTextareaText().length
    applyPrompt(nextPrompt, offset + insertedLength)
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

  const moveFactUserInputHistory = (direction: 1 | -1) => {
    if (!textarea) return
    const current = clonePromptInfo({
      ...store.prompt,
      input: textarea.plainText,
    })
    const state = {
      ...factHistoryState(),
      history: (props.userInputHistory ?? []).map(clonePromptInfo),
    }
    const { nextState, prompt } = movePromptHistoryCursor(state, direction, current)
    setFactHistoryState(nextState)
    if (prompt) restorePrompt(prompt)
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
          insertAttachments(
            [{ path: file.absolutePath, filename: file.relativePath, mime: "text/plain" }],
            insertOffset,
          )
        }}
      />
    ))
  }

  const pasteFromClipboard = async () => {
    if (!textarea) return
    const content = await Clipboard.read()
    if (!content) return
    if (content.mime.startsWith("image/")) {
      insertAttachments(
        [
          {
            path: "clipboard-image.png",
            filename: "clipboard-image.png",
            mime: content.mime,
            url: `data:${content.mime};base64,${content.data}`,
          },
        ],
        textarea.visualCursor.offset,
      )
    } else {
      pasteText(textarea, content.data, content.data, undefined, promptPartTypeId, setStore)
    }
    syncGraphComposer()
  }

  useKeyboard((event) => {
    if (!focused() || !textarea || props.busy || props.blocked) return
    if (event.defaultPrevented) return

    if (event.name === "backspace" || event.name === "delete") {
      const selection = textarea.getSelection() ?? undefined
      const originalPrompt = clonePromptInfo({ ...store.prompt, input: textarea.plainText })
      const result = deleteAttachmentBlocksFromPrompt(originalPrompt, {
        key: event.name,
        cursorOffset: textarea.visualCursor.offset,
        selection,
      })
      if (result.deletedPartIndexes.length) {
        const attachmentStarts = result.deletedPartIndexes.flatMap((index) => {
          const part = originalPrompt.parts[index]
          return part?.type === "file" && part.source?.text ? [part.source.text.start] : []
        })
        const cursorOffset = Math.min(selection?.start ?? Number.POSITIVE_INFINITY, ...attachmentStarts)
        event.preventDefault()
        event.stopPropagation()
        applyPrompt(result.prompt, Number.isFinite(cursorOffset) ? cursorOffset : textarea.visualCursor.offset)
        return
      }
    }

    if ((event as { shift?: boolean }).shift && event.name === "up") {
      moveFactUserInputHistory(-1)
      event.preventDefault()
      return
    }

    if ((event as { shift?: boolean }).shift && event.name === "down") {
      moveFactUserInputHistory(1)
      event.preventDefault()
      return
    }

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
        const wasFocused = focused()
        props.onFocusRequest?.()
        if (!wasFocused && textarea) {
          setTimeout(() => {
            if (!textarea!.isDestroyed) {
              textarea!.cursorOffset = textarea!.plainText.length
            }
          }, 0)
        }
      }}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onFocusRequest?.()
        textarea?.focus()
      }}
      onMouseScroll={routeHistoryScroll}
    >
      <box flexDirection="row" onMouseScroll={routeHistoryScroll}>
        <text fg={props.statusLabel ? theme.warning : props.busy ? theme.warning : theme.textMuted} overflow="hidden">
          {props.statusLabel ??
            (props.blocked
              ? props.blockLabel ?? "approval required before submit"
              : props.busy
                ? "streaming local reply"
                : "Enter 发送 · Ctrl+J or Shift+Enter 换行")}
        </text>
      </box>
      <Show when={canonicalPartCount() > 0}>
        <text fg={theme.secondary} wrapMode="char" onMouseScroll={routeHistoryScroll}>
          parts {promptPartSummary()}
        </text>
      </Show>

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
              setTimeout(() => {
                if (!value.isDestroyed) {
                  value.cursorOffset = value.plainText.length
                }
              }, 0)
              props.onReady?.(value)
            }}
            focused={focused()}
            minHeight={2}
            maxHeight={4}
            initialValue={value()}
            placeholder={composerPlaceholder()}
            keyBindings={composerBindings()}
            onPaste={(event: PasteEvent) => {
              if (!props.isAttachmentFile) return
              const payload = new TextDecoder().decode(event.bytes)
              const candidates = parseAttachmentPathPaste(payload, {
                platform: process.platform === "win32" ? "win32" : "posix",
                isFile: props.isAttachmentFile,
              })
              if (!candidates) return
              event.preventDefault()
              event.stopPropagation()
              insertAttachments(
                candidates.map((candidate) => ({
                  path: candidate,
                  filename:
                    process.platform === "win32" ? path.win32.basename(candidate) : path.posix.basename(candidate),
                  mime: "text/plain",
                })),
                textarea?.visualCursor.offset ?? store.prompt.input.length,
              )
            }}
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
              void Promise.resolve(props.onSubmit(prompt, clearPrompt))
            }}
          />
        </box>
      <box flexDirection="row" onMouseScroll={routeHistoryScroll}>
        <text flexGrow={1} fg={focused() ? theme.userBorder : theme.textMuted} overflow="hidden">
          {props.selectionLabel}
        </text>
        <box flexShrink={0}>
          <text fg={focused() ? theme.userBorder : theme.textMuted}>
            {value().length} chars · {canonicalPartCount()} parts
          </text>
        </box>
      </box>
    </box>
  )
}
