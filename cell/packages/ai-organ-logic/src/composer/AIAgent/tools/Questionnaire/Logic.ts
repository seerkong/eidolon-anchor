import type { StdInnerLogic } from "depa-processor"
import type { QuestionnaireRequestPayload } from "@cell/ai-core-contract/runtime/Questionnaire"
import type {
  QuestionnaireInnerConfig,
  QuestionnaireInnerInput,
  QuestionnaireInnerOutput,
  QuestionnaireInnerRuntime,
} from "./InnerTypes"

export const questionnaireCoreLogic: StdInnerLogic<
  QuestionnaireInnerRuntime,
  QuestionnaireInnerInput,
  QuestionnaireInnerConfig,
  QuestionnaireInnerOutput
> = async (runtime, input) => {
  const toolCallId = String((runtime as any)?.toolCallId ?? "").trim()
  const questionnaireId =
    typeof input.questionnaireId === "string" && input.questionnaireId ? input.questionnaireId : toolCallId ? `q-${toolCallId}` : `q-${Date.now()}`

  const kindRaw = typeof input.kind === "string" ? input.kind : "freeform"
  const kind =
    kindRaw === "clarification" || kindRaw === "approval" || kindRaw === "freeform" || kindRaw === "form" ? kindRaw : "freeform"

  const suspendPolicyRaw = typeof input.suspendPolicy === "string" ? input.suspendPolicy : "pause_all"
  const suspendPolicy = suspendPolicyRaw === "continue_others" ? "continue_others" : "pause_all"

  const title = typeof input.title === "string" && input.title ? input.title : undefined
  const intro = typeof input.intro === "string" && input.intro ? input.intro : undefined

  const questions = Array.isArray((input as any)?.questions) ? (input as any).questions : []
  const normalizedQuestions = questions
    .map((q: any, idx: number) => {
      const id = typeof q?.id === "string" && q.id ? q.id : `q${idx + 1}`
      const prompt = typeof q?.prompt === "string" ? q.prompt : ""
      const type = typeof q?.type === "string" ? q.type : "text"
      const required = typeof q?.required === "boolean" ? q.required : undefined
      const choices = Array.isArray(q?.choices) ? q.choices : undefined
      const def = q?.default
      const helpText = typeof q?.helpText === "string" ? q.helpText : undefined
      return { id, prompt, type, required, choices, default: def, helpText }
    })
    .filter((q: any) => q.prompt)

  if (normalizedQuestions.length === 0) {
    const fallbackPrompt = intro || title || "User input required"
    normalizedQuestions.push({ id: "q1", prompt: fallbackPrompt, type: "text" })
  }

  const payload: QuestionnaireRequestPayload = {
    questionnaireId,
    toolCallId: toolCallId || questionnaireId,
    kind: kind as any,
    title,
    intro,
    suspendPolicy,
    questions: normalizedQuestions as any,
  }

  // Idempotency guard: don't duplicate pending records on retries.
  const existing = (runtime.actor as any)?.pendingQuestionnaires?.[questionnaireId]
  if (!existing) {
    ;(runtime.actor as any).pendingQuestionnaires[questionnaireId] = payload
    runtime.actor.send("control" as any, {
      kind: "questionnaire_pending",
      toolCallId: payload.toolCallId,
      questionnaireId: payload.questionnaireId,
      suspendPolicy: payload.suspendPolicy,
    })

    const bus = (runtime.vm as any)?.eventBus
    if (bus && typeof bus.emitQuestionnaireRequest === "function") {
      bus.emitQuestionnaireRequest({ key: runtime.actor.key, id: runtime.actor.id }, payload)
    }
  }

  // Return value is irrelevant for control flow; executor relies on the pending marker.
  return ""
}
