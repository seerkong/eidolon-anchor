export type QuestionnaireKind = "clarification" | "approval" | "freeform" | "form";

export type QuestionnaireSuspendPolicy = "pause_all" | "continue_others";

export type QuestionnaireQuestionType =
  | "text"
  | "yes_no"
  | "single_select"
  | "multi_select"
  | "number"
  | "json";

export type QuestionnaireChoice =
  | string
  | {
      value: string;
      label?: string;
    };

export type QuestionnaireQuestion = {
  id: string;
  prompt: string;
  type: QuestionnaireQuestionType;
  required?: boolean;
  choices?: QuestionnaireChoice[];
  default?: unknown;
  helpText?: string;
};

export type QuestionnaireRequestPayload = {
  questionnaireId: string;
  toolCallId: string;
  kind: QuestionnaireKind;
  title?: string;
  intro?: string;
  suspendPolicy: QuestionnaireSuspendPolicy;
  questions: QuestionnaireQuestion[];
};

export type QuestionnaireResultStatus = "ok" | "invalid";

export type QuestionnaireResultPayload = {
  questionnaireId: string;
  toolCallId: string;
  rawText: string;
  status: QuestionnaireResultStatus;
  answers: Record<string, unknown>;
  errors?: string[];
};

export type QuestionnaireRowStatus = "pending" | "answered" | "cancelled" | "expired";

export type QuestionnaireRow = {
  questionnaireId: string;
  sessionId?: string;
  ownerActorId?: string;
  ownerActorKey?: string;
  ownerFiberId?: string;
  toolCallId: string;
  request: QuestionnaireRequestPayload;
  result?: QuestionnaireResultPayload;
  suspendPolicy: QuestionnaireSuspendPolicy;
  status: QuestionnaireRowStatus;
  createdAt?: number;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
};
