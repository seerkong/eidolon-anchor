import type {
  QuestionnaireRequestData,
  QuestionnaireStructuredQuestionData,
} from "@cell/ai-core-contract/stream/common";
import {
  buildQuestionnaireProtocolQuestion,
  buildQuestionnaireReplyHint,
  type QuestionnaireProtocolSourceQuestion,
} from "@cell/ai-core-contract/runtime/QuestionnaireProtocol";

type PresentedQuestion = ReturnType<typeof buildQuestionnaireProtocolQuestion>;

export function formatQuestionnaireRequestText(
  request: QuestionnaireRequestData,
): string {
  const questions = getPresentedQuestions(request);
  if (questions.length === 0) {
    return formatLegacyQuestionnaire(request);
  }

  const sourceQuestions = questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    type: question.type,
    required: question.required,
    choices: question.options
      .filter((option) => !option.isCustom)
      .map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
      })),
    helpText: question.helpText,
  })) satisfies QuestionnaireProtocolSourceQuestion[];

  const lines: string[] = [];
  lines.push(request.title_text || request.question);
  if (request.intro_text && request.intro_text.trim()) {
    lines.push(request.intro_text.trim());
  }
  lines.push(buildQuestionnaireReplyHint(sourceQuestions));

  for (const question of questions) {
    lines.push("");
    lines.push(`${question.header}. ${question.prompt}`);
    for (const option of question.options) {
      lines.push(`${option.code}) ${option.label}`);
      if (option.description) {
        lines.push(`   ${option.description}`);
      }
    }
    if (question.helpText) {
      lines.push(`Hint: ${question.helpText}`);
    }
  }

  return lines.join("\n");
}

function getPresentedQuestions(
  request: QuestionnaireRequestData,
): PresentedQuestion[] {
  if (Array.isArray(request.questions) && request.questions.length > 0) {
    return request.questions.map((question, index) =>
      buildQuestionnaireProtocolQuestion(structuredQuestionToProtocolSource(question), index),
    );
  }

  return [];
}

function structuredQuestionToProtocolSource(
  question: QuestionnaireStructuredQuestionData,
): QuestionnaireProtocolSourceQuestion {
  return {
    id: question.question_id,
    prompt: question.prompt,
    type: question.question_type,
    required: question.required,
    choices: question.options.map((option) => ({
      value: option.value_text,
      label: option.label,
      description: option.description || undefined,
    })),
    helpText: question.help_text || undefined,
  };
}

function formatLegacyQuestionnaire(request: QuestionnaireRequestData): string {
  let text = `${request.question}\n`;
  if (request.options.length > 0) {
    for (let index = 0; index < request.options.length; index += 1) {
      const option = request.options[index]!;
      text += `${index + 1}) ${option.label}\n`;
    }
  } else {
    text += `1) ${request.input_kind}\n`;
  }
  return text.trimEnd();
}
