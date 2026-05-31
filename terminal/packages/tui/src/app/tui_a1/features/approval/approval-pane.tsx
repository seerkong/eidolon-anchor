/** @jsxImportSource @opentui/solid */
import type { TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { PermissionRequest, QuestionAnswer, QuestionRequest } from "@terminal/core/AIAgent"
import { useTextareaKeybindings } from "../../../../ui/primitives/textarea-keybindings"
import { SplitBorder } from "../../../../ui/primitives/border"
import { tuiA1Theme as theme } from "../../theme"
import { renderPermissionDetails, renderPermissionSummary, resolveQuestionAnswers } from "./approval-utils"

type PermissionReply = "once" | "always" | "reject"

function PermissionApprovalPane(props: {
  request: PermissionRequest
  onReply: (reply: PermissionReply) => void
}) {
  const summary = createMemo(() => renderPermissionSummary(props.request))
  const details = createMemo(() => renderPermissionDetails(props.request))

  useKeyboard((event) => {
    if (event.name === "return" || event.name === "a") {
      event.preventDefault()
      props.onReply("once")
      return
    }
    if (event.name === "w") {
      event.preventDefault()
      props.onReply("always")
      return
    }
    if (event.name === "escape" || event.name === "r") {
      event.preventDefault()
      props.onReply("reject")
    }
  })

  return (
    <box
      flexShrink={0}
      border={["left"]}
      borderColor={theme.warning}
      customBorderChars={SplitBorder.customBorderChars}
      backgroundColor={theme.backgroundPanel}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="column">
        <box flexDirection="row">
          <text fg={theme.warning}>Permission required</text>
          <box flexGrow={1} />
          <text fg={theme.textMuted}>{props.request.id}</text>
        </box>

        <text fg={theme.text}>
          {props.request.permission}
          <Show when={summary().length > 0}>
            <span style={{ fg: theme.textMuted }}> · {summary()}</span>
          </Show>
        </text>

        <Show when={details().length > 0}>
          <For each={details()}>
            {(line) => <text fg={theme.textMuted}>{line}</text>}
          </For>
        </Show>

        <box flexDirection="row" gap={1}>
          <text fg={theme.success} onMouseDown={() => props.onReply("once")}>
            [Allow once]
          </text>
          <text fg={theme.secondary} onMouseDown={() => props.onReply("always")}>
            [Always]
          </text>
          <text fg={theme.error} onMouseDown={() => props.onReply("reject")}>
            [Reject]
          </text>
        </box>
        <text fg={theme.textMuted}>enter/a allow once · w allow always · esc/r reject</text>
      </box>
    </box>
  )
}

function ensureAnswerCapacity(answers: QuestionAnswer[], size: number): QuestionAnswer[] {
  const next = answers.map((answer) => [...answer])
  while (next.length < size) {
    next.push([])
  }
  return next
}

function ensureCustomValueCapacity(values: string[], size: number): string[] {
  const next = [...values]
  while (next.length < size) {
    next.push("")
  }
  return next
}

function QuestionApprovalPane(props: {
  request: QuestionRequest
  onReply: (answers: QuestionAnswer[]) => void
  onReject: () => void
}) {
  const bindings = useTextareaKeybindings()
  const [questionIndex, setQuestionIndex] = createSignal(0)
  const [optionIndex, setOptionIndex] = createSignal(0)
  const [answers, setAnswers] = createSignal<QuestionAnswer[]>([])
  const [customValues, setCustomValues] = createSignal<string[]>([])
  const [editingCustom, setEditingCustom] = createSignal(false)
  let customInput: TextareaRenderable | undefined

  const questions = createMemo(() => props.request.questions ?? [])
  const currentQuestion = createMemo(() => questions()[questionIndex()])
  const options = createMemo(() => currentQuestion()?.options ?? [])
  const allowsCustom = createMemo(() => currentQuestion()?.custom !== false)
  const customOptionIndex = createMemo(() => options().length)
  const choiceCount = createMemo(() => options().length + (allowsCustom() ? 1 : 0))
  const isCustomFocused = createMemo(() => allowsCustom() && optionIndex() === customOptionIndex())
  const isMultiple = createMemo(() => currentQuestion()?.multiple === true)
  const currentAnswers = createMemo(() => answers()[questionIndex()] ?? [])
  const currentCustomValue = createMemo(() => customValues()[questionIndex()] ?? "")
  const currentCustomPicked = createMemo(() => {
    const value = currentCustomValue().trim()
    if (!value) return false
    return currentAnswers().includes(value)
  })
  const customCode = createMemo(() => {
    const question = currentQuestion() as (QuestionRequest["questions"][number] & { customOptionCode?: string }) | undefined
    return typeof question?.customOptionCode === "string" && question.customOptionCode.trim()
      ? question.customOptionCode.trim()
      : ""
  })

  const updateCurrentAnswers = (value: string[]) => {
    setAnswers((previous) => {
      const next = ensureAnswerCapacity(previous, questions().length)
      next[questionIndex()] = value
      return next
    })
  }

  const setCurrentCustomValue = (value: string) => {
    setCustomValues((previous) => {
      const next = ensureCustomValueCapacity(previous, questions().length)
      next[questionIndex()] = value
      return next
    })
  }

  const updateCurrentCustomAnswer = (value: string) => {
    const trimmed = value.trim()
    const previous = currentCustomValue().trim()
    setCurrentCustomValue(trimmed)
    setAnswers((prev) => {
      const next = ensureAnswerCapacity(prev, questions().length)
      let row = [...(next[questionIndex()] ?? [])]
      if (previous.length > 0) {
        row = row.filter((item) => item !== previous)
      }
      if (trimmed.length > 0) {
        if (isMultiple()) {
          if (!row.includes(trimmed)) {
            row.push(trimmed)
          }
        } else {
          row = [trimmed]
        }
      }
      next[questionIndex()] = row
      return next
    })
  }

  const toggleCurrentOption = () => {
    const option = options()[optionIndex()]
    if (!option) return
    const next = new Set(currentAnswers())
    if (next.has(option.label)) {
      next.delete(option.label)
    } else {
      next.add(option.label)
    }
    updateCurrentAnswers([...next])
  }

  const submitAnswers = () => {
    props.onReply(resolveQuestionAnswers(questions(), answers()))
  }

  const goToQuestion = (nextIndex: number) => {
    const total = questions().length
    if (total === 0) return
    const bounded = Math.max(0, Math.min(total - 1, nextIndex))
    setQuestionIndex(bounded)
    setOptionIndex(0)
    setEditingCustom(false)
  }

  const startCustomEditing = () => {
    setEditingCustom(true)
    queueMicrotask(() => {
      customInput?.setText(currentCustomValue())
      customInput?.focus()
    })
  }

  const completeCustomEditing = () => {
    const value = customInput?.plainText ?? currentCustomValue()
    updateCurrentCustomAnswer(value)
    setEditingCustom(false)
    if (value.trim().length === 0 || isMultiple()) return
    if (questionIndex() >= questions().length - 1) {
      submitAnswers()
      return
    }
    goToQuestion(questionIndex() + 1)
  }

  const submitCurrentSelection = () => {
    if (isCustomFocused()) {
      if (editingCustom()) {
        completeCustomEditing()
      } else {
        startCustomEditing()
      }
      return
    }

    if (isMultiple()) {
      if (questionIndex() >= questions().length - 1) {
        submitAnswers()
        return
      }
      goToQuestion(questionIndex() + 1)
      return
    }

    const option = options()[optionIndex()]
    if (!option) return
    updateCurrentAnswers([option.label])
    if (questionIndex() >= questions().length - 1) {
      submitAnswers()
      return
    }
    goToQuestion(questionIndex() + 1)
  }

  useKeyboard((event) => {
    if (editingCustom()) {
      if (event.name === "escape") {
        event.preventDefault()
        setEditingCustom(false)
        return
      }
      if (event.name === "return") {
        event.preventDefault()
        completeCustomEditing()
      }
      return
    }

    if (event.name === "escape" || event.name === "q") {
      event.preventDefault()
      props.onReject()
      return
    }

    if (event.name === "left") {
      event.preventDefault()
      goToQuestion(questionIndex() - 1)
      return
    }
    if (event.name === "right") {
      event.preventDefault()
      goToQuestion(questionIndex() + 1)
      return
    }

    const total = choiceCount()
    if (total === 0) return

    if (event.name === "up" || event.name === "k") {
      event.preventDefault()
      setOptionIndex((current) => (current - 1 + total) % total)
      return
    }
    if (event.name === "down" || event.name === "j") {
      event.preventDefault()
      setOptionIndex((current) => (current + 1) % total)
      return
    }
    if (event.name === "space" && isMultiple() && !isCustomFocused()) {
      event.preventDefault()
      toggleCurrentOption()
      return
    }
    if (event.name === "return") {
      event.preventDefault()
      submitCurrentSelection()
    }
  })

  const focusOption = (index: number) => {
    const total = choiceCount()
    if (total <= 0) return
    const bounded = Math.max(0, Math.min(total - 1, index))
    setOptionIndex(bounded)
  }

  const clickOption = (index: number) => {
    focusOption(index)
    if (isCustomFocused()) {
      if (editingCustom()) return
      startCustomEditing()
      return
    }
    if (isMultiple()) {
      toggleCurrentOption()
      return
    }
    submitCurrentSelection()
  }

  return (
    <box
      flexShrink={0}
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={SplitBorder.customBorderChars}
      backgroundColor={theme.backgroundPanel}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="column">
        <box flexDirection="row">
          <text fg={theme.accent}>Question required</text>
          <box flexGrow={1} />
          <text fg={theme.textMuted}>
            {Math.min(questionIndex() + 1, questions().length)}/{questions().length || 1}
          </text>
        </box>

        <text fg={theme.text}>
          {(currentQuestion()?.header ? `${currentQuestion()?.header}. ` : "") + (currentQuestion()?.question ?? "No question payload")}
          <Show when={isMultiple()}>
            <span style={{ fg: theme.textMuted }}> (select all that apply)</span>
          </Show>
        </text>

        <For each={options()}>
          {(option, index) => {
            const focused = () => index() === optionIndex()
            const checked = () => currentAnswers().includes(option.label)
            return (
              <box
                flexDirection="column"
                onMouseDown={() => {
                  clickOption(index())
                }}
              >
                <text fg={focused() ? theme.secondary : theme.textMuted}>
                  {focused() ? ">" : " "} {checked() ? "[x]" : "[ ]"} {typeof (option as any).code === "string" ? `${(option as any).code}) ` : ""}{option.label}
                </text>
                <Show when={option.description}>
                  <text fg={theme.textMuted}>  {option.description}</text>
                </Show>
              </box>
            )
          }}
        </For>

        <Show when={allowsCustom()}>
          <text
            fg={isCustomFocused() ? theme.secondary : theme.textMuted}
            onMouseDown={() => {
              clickOption(customOptionIndex())
            }}
          >
            {isCustomFocused() ? ">" : " "} {currentCustomPicked() ? "[x]" : "[ ]"} {customCode() ? `${customCode()}) ` : ""}Type your own answer
          </text>
          <Show when={editingCustom()}>
            <box paddingLeft={2}>
              <textarea
                ref={(value: TextareaRenderable) => {
                  customInput = value
                }}
                focused
                initialValue={currentCustomValue()}
                minHeight={1}
                maxHeight={3}
                keyBindings={bindings()}
                textColor={theme.text}
                focusedTextColor={theme.text}
                placeholderColor={theme.textMuted}
                placeholder="Type custom answer"
                backgroundColor={theme.backgroundElement}
                focusedBackgroundColor={theme.backgroundElement}
                onSubmit={() => {
                  completeCustomEditing()
                }}
              />
            </box>
          </Show>
          <Show when={!editingCustom() && currentCustomValue().trim().length > 0}>
            <text fg={theme.textMuted}>  {currentCustomValue()}</text>
          </Show>
        </Show>

        <text fg={theme.textMuted}>
          {editingCustom()
            ? "enter save custom answer · esc cancel"
            : isMultiple()
              ? "space toggle · enter next/submit · left/right switch question · esc reject"
              : "enter select · left/right switch question · esc reject"}
        </text>
      </box>
    </box>
  )
}

export function ApprovalPane(props: {
  permission?: PermissionRequest
  question?: QuestionRequest
  onPermissionReply: (request: PermissionRequest, reply: PermissionReply) => void
  onQuestionReply: (request: QuestionRequest, answers: QuestionAnswer[]) => void
  onQuestionReject: (request: QuestionRequest) => void
}) {
  return (
    <Show
      when={props.permission}
      fallback={
        <Show when={props.question}>
          {(request: () => QuestionRequest) => (
            <QuestionApprovalPane
              request={request()}
              onReply={(answers) => props.onQuestionReply(request(), answers)}
              onReject={() => props.onQuestionReject(request())}
            />
          )}
        </Show>
      }
    >
      {(request: () => PermissionRequest) => <PermissionApprovalPane request={request()} onReply={(reply) => props.onPermissionReply(request(), reply)} />}
    </Show>
  )
}
