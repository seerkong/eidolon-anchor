import type { LlmAdapter } from "@cell/ai-core-contract/LlmTypes";
import type {
  QuestionnaireQuestion,
  QuestionnaireRequestPayload,
  QuestionnaireResultStatus,
} from "@cell/ai-core-contract/runtime/Questionnaire";
import {
  asQuestionnaireProtocolSourceQuestions,
  buildQuestionnaireProtocolQuestions,
} from "@cell/ai-core-contract/runtime/QuestionnaireProtocol";

export type ParsedQuestionnaireAnswer = {
  status: QuestionnaireResultStatus;
  answers: Record<string, unknown>;
  errors?: string[];
};

type ParseQuestionnaireAnswerParams = {
  llmAdapter: LlmAdapter;
  model: string;
  request: QuestionnaireRequestPayload;
  rawText: string;
};

const PARSER_SYSTEM_PROMPT = `QUESTIONNAIRE_ANSWER_PARSER_V2

You convert a user's questionnaire reply into strict JSON answers.

Rules:
- Output ONLY valid JSON. No markdown. No commentary.
- JSON must be an object with keys: status, answers, errors.
- status must be "ok" or "invalid".
- answers must be an object mapping question id -> parsed value.
- errors must be an array of short human-readable strings.
- If the reply is ambiguous, incomplete, contradictory, or does not match the questionnaire protocol, return status="invalid".

Question type expectations:
- text -> string
- yes_no -> boolean
- number -> number
- single_select -> string
- multi_select -> array of strings
- json -> any valid JSON value

Protocol handling:
- The input includes a protocol presentation block with question headers like Q1, Q2 and option codes like A, B, C.
- Use that presentation block to interpret coded replies such as "Q1: A ; Q2: B" or "Q3: D quiet and less commercial".
- When the selected option is a free-text branch, return only the user-provided text, not the option code.
- When the selected option is a normal choice branch, return the canonical choice value from the protocol context.
- For text questions that are rendered with a single free-text option, strip the option code and keep only the user's text.
- If a required question is missing, include an error that names the missing question id.
`;

async function collectStreamText(stream: AsyncIterable<any>): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      text += chunk;
      continue;
    }

    const delta = chunk?.choices?.[0]?.delta;
    if (typeof delta?.content === "string") {
      text += delta.content;
      continue;
    }

    if (Array.isArray(delta?.content)) {
      for (const part of delta.content) {
        if (typeof part?.text === "string") {
          text += part.text;
        }
      }
      continue;
    }

    if (chunk?.type === "text-delta" && typeof chunk?.text === "string") {
      text += chunk.text;
      continue;
    }

    if (typeof chunk?.text === "string") {
      text += chunk.text;
    }
  }

  return text.trim();
}

type ProtocolAnswerParseResult =
  | {
      matched: false;
    }
  | {
      matched: true;
      answers: Record<string, unknown>;
      errors: string[];
    };

function coerceAnswerValue(question: QuestionnaireQuestion, value: unknown): { ok: boolean; value?: unknown; error?: string } {
  switch (question.type) {
    case "text": {
      if (typeof value === "string") return { ok: true, value };
      if (value === undefined || value === null) return { ok: true, value: "" };
      return { ok: true, value: String(value) };
    }
    case "yes_no": {
      if (typeof value === "boolean") return { ok: true, value };
      if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        if (["yes", "y", "true", "1"].includes(v)) return { ok: true, value: true };
        if (["no", "n", "false", "0"].includes(v)) return { ok: true, value: false };
      }
      return { ok: false, error: `invalid yes_no for '${question.id}'` };
    }
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
      if (typeof value === "string") {
        const n = Number(value.trim());
        if (Number.isFinite(n)) return { ok: true, value: n };
      }
      return { ok: false, error: `invalid number for '${question.id}'` };
    }
    case "single_select": {
      const v = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
      if (!question.choices || question.choices.length === 0) {
        return v ? { ok: true, value: v } : { ok: false, error: `missing selection for '${question.id}'` };
      }
      const allowed = new Set(question.choices.map((c) => (typeof c === "string" ? c : String(c.value))));
      if (allowed.has(v)) return { ok: true, value: v };
      const byLabel = buildChoiceLabelMap(question);
      const mapped = byLabel.get(v.trim().toLowerCase());
      if (mapped) return { ok: true, value: mapped };
      return v.trim() ? { ok: true, value: v.trim() } : { ok: false, error: `missing selection for '${question.id}'` };
    }
    case "multi_select": {
      const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      const byLabel = buildChoiceLabelMap(question);
      const out: string[] = [];
      for (const entry of values) {
        const normalized = typeof entry === "string" ? entry : String(entry);
        if (!question.choices || question.choices.length === 0) {
          out.push(normalized);
          continue;
        }
        const allowed = new Set(
          question.choices.map((c) => (typeof c === "string" ? c : String(c.value))),
        );
        if (allowed.has(normalized)) {
          out.push(normalized);
          continue;
        }
        const mapped = byLabel.get(normalized.trim().toLowerCase());
        if (mapped) {
          out.push(mapped);
          continue;
        }
        if (normalized.trim()) {
          out.push(normalized.trim());
        }
      }
      if (!question.choices || question.choices.length === 0) {
        return { ok: true, value: out };
      }
      return { ok: true, value: out };
    }
    case "json": {
      if (typeof value === "string") {
        try {
          return { ok: true, value: JSON.parse(value) };
        } catch {
          return { ok: false, error: `invalid json for '${question.id}'` };
        }
      }
      return { ok: true, value };
    }
    default: {
      return { ok: true, value };
    }
  }
}

function validateAnswers(request: QuestionnaireRequestPayload, answers: Record<string, unknown>): ParsedQuestionnaireAnswer {
  const errors: string[] = [];
  const coerced: Record<string, unknown> = {};

  for (const q of request.questions) {
    const has = Object.prototype.hasOwnProperty.call(answers, q.id);
    if (!has) {
      if (q.required) {
        errors.push(`missing required answer: '${q.id}'`);
      }
      continue;
    }

    const result = coerceAnswerValue(q, answers[q.id]);
    if (!result.ok) {
      errors.push(result.error || `invalid answer: '${q.id}'`);
      continue;
    }
    coerced[q.id] = result.value;
  }

  if (errors.length) {
    return { status: "invalid", answers: coerced, errors };
  }
  return { status: "ok", answers: coerced, errors: [] };
}

function tryParseProtocolAnswers(
  request: QuestionnaireRequestPayload,
  rawText: string,
): ProtocolAnswerParseResult {
  const protocolQuestions = buildQuestionnaireProtocolQuestions(
    asQuestionnaireProtocolSourceQuestions(request.questions),
  );
  const labelPattern = /\bq(\d+)\s*:/gi;
  const matches = [...rawText.matchAll(labelPattern)];

  if (matches.length === 0) {
    return { matched: false };
  }

  const prefix = rawText.slice(0, matches[0]!.index ?? 0).trim();
  if (prefix && prefix !== ";") {
    return {
      matched: true,
      answers: {},
      errors: ["invalid protocol answer prefix"],
    };
  }

  const answers: Record<string, unknown> = {};
  const errors: string[] = [];
  const seenQuestionIds = new Set<string>();

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const questionIndex = Number.parseInt(match[1] ?? "", 10) - 1;
    const question = request.questions[questionIndex];
    const protocolQuestion = protocolQuestions[questionIndex];
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1]!.index ?? rawText.length) : rawText.length;
    const segment = normalizeProtocolSegment(rawText.slice(start, end));

    if (!question || !protocolQuestion) {
      errors.push(`unknown question label: 'Q${questionIndex + 1}'`);
      continue;
    }
    if (seenQuestionIds.has(question.id)) {
      errors.push(`duplicate answer for '${question.id}'`);
      continue;
    }
    seenQuestionIds.add(question.id);

    const parsed = parseProtocolSegment(question, protocolQuestion, segment);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }
    answers[question.id] = parsed.value;
  }

  return { matched: true, answers, errors };
}

function normalizeProtocolSegment(segment: string): string {
  return segment.replace(/^[\s;]+/, "").replace(/[\s;]+$/, "").trim();
}

function parseProtocolSegment(
  question: QuestionnaireQuestion,
  protocolQuestion: ReturnType<typeof buildQuestionnaireProtocolQuestions>[number],
  segment: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!segment) {
    return { ok: false, error: `invalid answer format for '${question.id}'` };
  }

  if (question.type === "multi_select") {
    return parseProtocolMultiSelect(question, protocolQuestion, segment);
  }

  return parseProtocolSingleValue(question, protocolQuestion, segment);
}

function parseProtocolSingleValue(
  question: QuestionnaireQuestion,
  protocolQuestion: ReturnType<typeof buildQuestionnaireProtocolQuestions>[number],
  segment: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const customOnlyOption = getCustomOnlyProtocolOption(protocolQuestion);
  if (customOnlyOption) {
    const token = parseProtocolToken(segment);
    if (token?.code === customOnlyOption.code) {
      const customText = token.remainder.trim();
      if (!customText) {
        return { ok: false, error: `missing custom answer for '${question.id}'` };
      }
      return { ok: true, value: customText };
    }
    return { ok: true, value: segment };
  }

  const token = parseProtocolToken(segment);
  if (token) {
    const option = protocolQuestion.options.find((entry) => entry.code === token.code);
    if (!option) {
      return { ok: false, error: `invalid answer format for '${question.id}'` };
    }
    if (option.isCustom) {
      const customText = token.remainder.trim();
      if (!customText) {
        return { ok: false, error: `missing custom answer for '${question.id}'` };
      }
      return { ok: true, value: customText };
    }
    if (token.remainder.trim()) {
      return { ok: false, error: `invalid answer format for '${question.id}'` };
    }
    return { ok: true, value: option.value };
  }

  const customOption = protocolQuestion.options.find((entry) => entry.isCustom);
  if (customOption && protocolQuestion.options.length === 1) {
    return { ok: true, value: segment };
  }

  return { ok: false, error: `invalid answer format for '${question.id}'` };
}

function getCustomOnlyProtocolOption(
  protocolQuestion: ReturnType<typeof buildQuestionnaireProtocolQuestions>[number],
) {
  const [onlyOption] = protocolQuestion.options;
  if (protocolQuestion.options.length === 1 && onlyOption?.isCustom) {
    return onlyOption;
  }
  return null;
}

function parseProtocolMultiSelect(
  question: QuestionnaireQuestion,
  protocolQuestion: ReturnType<typeof buildQuestionnaireProtocolQuestions>[number],
  segment: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const parts = segment
    .split(/\s*,\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return { ok: false, error: `invalid answer format for '${question.id}'` };
  }

  const values: string[] = [];
  for (const part of parts) {
    const token = parseProtocolToken(part);
    if (!token) {
      return { ok: false, error: `invalid answer format for '${question.id}'` };
    }
    const option = protocolQuestion.options.find((entry) => entry.code === token.code);
    if (!option) {
      return { ok: false, error: `invalid answer format for '${question.id}'` };
    }
    if (option.isCustom) {
      const customText = token.remainder.trim();
      if (!customText) {
        return { ok: false, error: `missing custom answer for '${question.id}'` };
      }
      values.push(customText);
      continue;
    }
    if (token.remainder.trim()) {
      return { ok: false, error: `invalid answer format for '${question.id}'` };
    }
    values.push(option.value);
  }

  return { ok: true, value: values };
}

function parseProtocolToken(segment: string): { code: string; remainder: string } | null {
  const match = segment.match(/^([A-Za-z]+)(?:\s+(.*))?$/s);
  if (!match) return null;
  return {
    code: match[1]!.trim().toUpperCase(),
    remainder: (match[2] ?? "").trim(),
  };
}

export async function parseQuestionnaireAnswer(params: ParseQuestionnaireAnswerParams): Promise<ParsedQuestionnaireAnswer> {
  const { llmAdapter, model, request, rawText } = params;
  if (!rawText || !rawText.trim()) {
    return { status: "invalid", answers: {}, errors: ["empty answer"] };
  }

  const protocolParsed = tryParseProtocolAnswers(request, rawText.trim());
  if (protocolParsed.matched) {
    const validated = validateAnswers(request, protocolParsed.answers);
    if (protocolParsed.errors.length === 0 && validated.status === "ok") {
      return { status: "ok", answers: validated.answers, errors: [] };
    }
    return {
      status: "invalid",
      answers: validated.answers,
      errors: [...(validated.errors ?? []), ...protocolParsed.errors].filter(Boolean),
    };
  }

  const userPayload = JSON.stringify(buildParserInput(request, rawText));
  const { stream } = await llmAdapter.createStream({
    model,
    messages: [
      { role: "system", content: PARSER_SYSTEM_PROMPT },
      { role: "user", content: userPayload },
    ],
    tools: [],
    extraBody: { reasoning_split: false },
  });

  const text = await collectStreamText(stream);
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "invalid", answers: {}, errors: ["parser returned non-JSON output"] };
  }

  const rawAnswers = parsed?.answers && typeof parsed.answers === "object" ? (parsed.answers as Record<string, unknown>) : {};
  const validated = validateAnswers(request, rawAnswers);
  const parserStatus = parsed?.status === "ok" ? "ok" : "invalid";
  const extraErrors = Array.isArray(parsed?.errors) ? parsed.errors.map((x: any) => String(x)) : [];

  if (parserStatus === "ok" && validated.status === "ok") {
    return { status: "ok", answers: validated.answers, errors: [] };
  }

  return {
    status: "invalid",
    answers: validated.answers,
    errors: [...(validated.errors ?? []), ...extraErrors].filter(Boolean),
  };
}

function buildParserInput(request: QuestionnaireRequestPayload, rawText: string) {
  const protocolQuestions = buildQuestionnaireProtocolQuestions(
    asQuestionnaireProtocolSourceQuestions(request.questions),
  );

  return {
    rawText,
    request: {
      questionnaireId: request.questionnaireId,
      toolCallId: request.toolCallId,
      kind: request.kind,
      title: request.title ?? null,
      intro: request.intro ?? null,
      suspendPolicy: request.suspendPolicy,
      questions: request.questions,
    },
    protocol: {
      id: "ask-multi-question-free",
      questions: protocolQuestions.map((question) => ({
        id: question.id,
        header: question.header,
        prompt: question.prompt,
        type: question.type,
        required: question.required,
        helpText: question.helpText ?? null,
        options: question.options.map((option) => ({
          code: option.code,
          label: option.label,
          value: option.value,
          isCustom: option.isCustom,
          description: option.description ?? null,
        })),
      })),
    },
  };
}

function buildChoiceLabelMap(question: QuestionnaireQuestion): Map<string, string> {
  const map = new Map<string, string>();
  for (const choice of question.choices ?? []) {
    if (typeof choice === "string") {
      map.set(choice.trim().toLowerCase(), choice);
      continue;
    }
    const value = String(choice.value);
    map.set(value.trim().toLowerCase(), value);
    if (typeof choice.label === "string" && choice.label.trim()) {
      map.set(choice.label.trim().toLowerCase(), value);
    }
  }
  return map;
}
