export type QuestionnaireSuspendPolicy = "pause_all" | "continue_others"

export type QuestionnaireKind = "clarification" | "approval" | "freeform" | "form"

export type QuestionnaireQuestionType =
  | "text"
  | "yes_no"
  | "number"
  | "single_select"
  | "multi_select"
  | "json"

export type QuestionnaireChoice =
  | string
  | {
      value: string
      label?: string
    }

export type QuestionnaireQuestion = {
  id: string
  prompt: string
  type: QuestionnaireQuestionType
  required?: boolean
  choices?: QuestionnaireChoice[]
  default?: unknown
  helpText?: string
}

export type QuestionnaireOuterInput = {
  questionnaireId?: string
  kind?: QuestionnaireKind
  title?: string
  intro?: string
  suspendPolicy?: QuestionnaireSuspendPolicy
  questions: QuestionnaireQuestion[]
}

export type QuestionnaireOuterOutput = string
