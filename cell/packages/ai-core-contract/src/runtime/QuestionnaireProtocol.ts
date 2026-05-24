import type { QuestionnaireQuestion, QuestionnaireQuestionType } from "./Questionnaire";

export type QuestionnaireProtocolSourceChoice =
  | string
  | {
      value: string;
      label?: string;
      description?: string;
    };

export type QuestionnaireProtocolSourceQuestion = {
  id: string;
  prompt: string;
  type: QuestionnaireQuestionType | string;
  required?: boolean;
  choices?: QuestionnaireProtocolSourceChoice[];
  helpText?: string;
};

export type QuestionnaireProtocolOption = {
  code: string;
  label: string;
  value: string;
  description?: string;
  isCustom: boolean;
};

export type QuestionnaireProtocolQuestion = {
  id: string;
  header: string;
  prompt: string;
  type: QuestionnaireQuestionType | string;
  required: boolean;
  helpText?: string;
  options: QuestionnaireProtocolOption[];
};

const CUSTOM_LABEL_WITH_CHOICES = "Other (type your answer)";
const CUSTOM_LABEL_TEXT_ONLY = "Type your answer";

export function buildQuestionnaireProtocolQuestions(
  questions: QuestionnaireProtocolSourceQuestion[],
): QuestionnaireProtocolQuestion[] {
  return questions.map((question, index) => buildQuestionnaireProtocolQuestion(question, index));
}

export function buildQuestionnaireProtocolQuestion(
  question: QuestionnaireProtocolSourceQuestion,
  index: number,
): QuestionnaireProtocolQuestion {
  const baseOptions = getQuestionBaseOptions(question);
  const options: QuestionnaireProtocolOption[] = baseOptions.map((option, optionIndex) => ({
    code: questionnaireOptionCode(optionIndex),
    label: option.label,
    value: option.value,
    description: option.description,
    isCustom: false,
  }));

  options.push({
    code: questionnaireOptionCode(options.length),
    label: baseOptions.length > 0 ? CUSTOM_LABEL_WITH_CHOICES : CUSTOM_LABEL_TEXT_ONLY,
    value: "__custom__",
    description: undefined,
    isCustom: true,
  });

  return {
    id: question.id,
    header: questionnaireQuestionHeader(index),
    prompt: question.prompt,
    type: question.type,
    required: question.required === true,
    helpText: question.helpText,
    options,
  };
}

export function questionnaireQuestionHeader(index: number): string {
  return `Q${index + 1}`;
}

export function questionnaireOptionCode(index: number): string {
  let current = index;
  let code = "";
  do {
    code = String.fromCharCode(65 + (current % 26)) + code;
    current = Math.floor(current / 26) - 1;
  } while (current >= 0);
  return code;
}

export function buildQuestionnaireReplyHint(
  questions: QuestionnaireProtocolSourceQuestion[],
): string {
  const protocolQuestions = buildQuestionnaireProtocolQuestions(questions);
  if (protocolQuestions.length === 0) {
    return "Reply with your answer.";
  }
  if (protocolQuestions.length === 1) {
    const [question] = protocolQuestions;
    const customOption = question.options.find((option) => option.isCustom);
    if (question.options.length === 1 && customOption) {
      return `${question.header}: ${customOption.code} your answer`;
    }
    return `${question.header}: ${question.options[0]?.code ?? "A"}`;
  }
  return "Reply format: Q1: A ; Q2: B ; Q3: D your answer";
}

export function findQuestionnaireProtocolOptionByCode(
  question: QuestionnaireProtocolQuestion,
  code: string,
): QuestionnaireProtocolOption | undefined {
  const normalized = normalizeCode(code);
  return question.options.find((option) => option.code === normalized);
}

export function findQuestionnaireProtocolOptionByValue(
  question: QuestionnaireProtocolQuestion,
  value: string,
): QuestionnaireProtocolOption | undefined {
  const normalized = normalizeText(value);
  return question.options.find((option) => {
    if (option.isCustom) return false;
    return normalizeText(option.value) === normalized || normalizeText(option.label) === normalized;
  });
}

export function getQuestionnaireCustomOption(
  question: QuestionnaireProtocolQuestion,
): QuestionnaireProtocolOption | undefined {
  return question.options.find((option) => option.isCustom);
}

function getQuestionBaseOptions(question: QuestionnaireProtocolSourceQuestion): Array<{
  value: string;
  label: string;
  description?: string;
}> {
  const choices = Array.isArray(question.choices)
    ? question.choices
        .map((choice) => normalizeChoice(choice))
        .filter((choice): choice is NonNullable<typeof choice> => !!choice)
    : [];
  if (choices.length > 0) {
    return choices;
  }
  if (question.type === "yes_no") {
    return [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ];
  }
  return [];
}

function normalizeChoice(choice: QuestionnaireProtocolSourceChoice): {
  value: string;
  label: string;
  description?: string;
} | null {
  if (typeof choice === "string") {
    const value = choice.trim();
    return value ? { value, label: value } : null;
  }

  const value = typeof choice.value === "string" ? choice.value.trim() : "";
  const label = typeof choice.label === "string" && choice.label.trim() ? choice.label.trim() : value;
  if (!value || !label) return null;

  const description =
    typeof choice.description === "string" && choice.description.trim()
      ? choice.description.trim()
      : undefined;

  return { value, label, description };
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

export function asQuestionnaireProtocolSourceQuestions(
  questions: QuestionnaireQuestion[],
): QuestionnaireProtocolSourceQuestion[] {
  return questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    type: question.type,
    required: question.required,
    choices: question.choices as QuestionnaireProtocolSourceChoice[] | undefined,
    helpText: question.helpText,
  }));
}
