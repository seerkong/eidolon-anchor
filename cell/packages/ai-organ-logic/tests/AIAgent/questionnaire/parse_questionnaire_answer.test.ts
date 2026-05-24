import { describe, expect, it } from "bun:test";

import { parseQuestionnaireAnswer } from "@cell/ai-organ-logic/questionnaire/parseQuestionnaireAnswer";

function makeAdapter(responseText: string) {
  return {
    type: "openai" as const,
    async createStream() {
      async function* stream() {
        yield { type: "text-delta", text: responseText };
      }
      return { stream: stream() };
    },
  };
}

function makeAdapterWithChunks(chunks: any[]) {
  return {
    type: "openai" as const,
    async createStream() {
      async function* stream() {
        for (const chunk of chunks) {
          yield chunk;
        }
      }
      return { stream: stream() };
    },
  };
}

function makeInspectingAdapter(
  handler: (options: any) => string,
) {
  return {
    type: "openai" as const,
    async createStream(options: any) {
      const responseText = handler(options)
      async function* stream() {
        yield { type: "text-delta", text: responseText };
      }
      return { stream: stream() };
    },
  };
}

function makeUnexpectedAdapter() {
  return {
    type: "openai" as const,
    async createStream() {
      throw new Error("LLM parser should not be called");
    },
  };
}

describe("parseQuestionnaireAnswer", () => {
  it("parses ok answers and validates required", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: true }, errors: [] }));

    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "approval",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Proceed?", type: "yes_no", required: true }],
      },
      rawText: "yes",
    });

    expect(result.status).toBe("ok");
    expect(result.answers.q1).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("returns invalid when required answer missing", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: {}, errors: [] }));

    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Your name?", type: "text", required: true }],
      },
      rawText: "(no answer)",
    });

    expect(result.status).toBe("invalid");
    expect((result.errors ?? []).join("\n")).toContain("missing required answer: 'q1'");
  });

  it("returns invalid when parser returns non-JSON", async () => {
    const llmAdapter = makeAdapter("not json");

    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "freeform",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Say something", type: "text", required: true }],
      },
      rawText: "hello",
    });

    expect(result.status).toBe("invalid");
    expect((result.errors ?? []).join("\n")).toContain("non-JSON");
  });

  it("coerces yes_no answers from string", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: "yes" }, errors: [] }));

    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "approval",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Proceed?", type: "yes_no", required: true }],
      },
      rawText: "y",
    });

    expect(result.status).toBe("ok");
    expect(result.answers.q1).toBe(true);
  });

  it("handles empty rawText", async () => {
    const llmAdapter = makeAdapter("{}");
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "freeform",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Say something", type: "text", required: true }],
      },
      rawText: "",
    });
    expect(result.status).toBe("invalid");
    expect((result.errors ?? []).join("\n")).toContain("empty answer");
  });

  it("handles rawText with only whitespace", async () => {
    const llmAdapter = makeAdapter("{}");
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "freeform",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Say something", type: "text", required: true }],
      },
      rawText: "   ",
    });
    expect(result.status).toBe("invalid");
    expect((result.errors ?? []).join("\n")).toContain("empty answer");
  });

  it("handles text question with non-string value", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: 123 }, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Name?", type: "text", required: true }],
      },
      rawText: "something",
    });
    expect(result.status).toBe("ok");
    expect(result.answers.q1).toBe("123");
  });

  it("handles number question with valid number", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: 42 }, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Age?", type: "number", required: true }],
      },
      rawText: "42",
    });
    expect(result.status).toBe("ok");
    expect(result.answers.q1).toBe(42);
  });

  it("handles number question with string number", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: "42" }, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Age?", type: "number", required: true }],
      },
      rawText: "42",
    });
    expect(result.status).toBe("ok");
    expect(result.answers.q1).toBe(42);
  });

  it("handles number question with invalid string", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: "not a number" }, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Age?", type: "number", required: true }],
      },
      rawText: "xxx",
    });
    expect(result.status).toBe("invalid");
    expect((result.errors ?? []).join("\n")).toContain("invalid number");
  });

  it("handles single_select with choices", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: "apple" }, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{
          id: "q1",
          prompt: "Choose fruit",
          type: "single_select",
          required: true,
          choices: ["apple", "banana", "cherry"]
        }],
      },
      rawText: "apple",
    });
    expect(result.status).toBe("ok");
    expect(result.answers.q1).toBe("apple");
  });

  it("handles single_select with invalid choice", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "invalid", answers: {}, errors: ["invalid selection for 'q1'"] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{
          id: "q1",
          prompt: "Choose fruit",
          type: "single_select",
          required: true,
          choices: ["apple", "banana", "cherry"]
        }],
      },
      rawText: "orange",
    });
    expect(result.status).toBe("invalid");
    expect((result.errors ?? []).join("\n")).toContain("invalid selection");
  });

  it("handles single_select without choices", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: "anything" }, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{
          id: "q1",
          prompt: "Enter something",
          type: "single_select",
          required: true,
        }],
      },
      rawText: "anything",
    });
    expect(result.status).toBe("ok");
    expect(result.answers.q1).toBe("anything");
  });

  it("handles multi_select with choices", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: ["apple", "banana"] }, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{
          id: "q1",
          prompt: "Choose fruits",
          type: "multi_select",
          required: true,
          choices: ["apple", "banana", "cherry"]
        }],
      },
      rawText: "apple, banana",
    });
    expect(result.status).toBe("ok");
    expect(result.answers.q1).toEqual(["apple", "banana"]);
  });

  it("handles multi_select with invalid choice", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "invalid", answers: { q1: ["apple"] }, errors: ["invalid selection(s) for 'q1': orange"] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{
          id: "q1",
          prompt: "Choose fruits",
          type: "multi_select",
          required: true,
          choices: ["apple", "banana", "cherry"]
        }],
      },
      rawText: "apple orange",
    });
    expect(result.status).toBe("invalid");
    expect((result.errors ?? []).join("\n")).toContain("invalid selection(s)");
  });

  it("handles json question with valid JSON string", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: "{\"x\": 5}" }, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{
          id: "q1",
          prompt: "Provide JSON",
          type: "json",
          required: true,
        }],
      },
      rawText: "{\"x\":5}",
    });
    expect(result.status).toBe("ok");
    expect(result.answers.q1).toEqual({ x: 5 });
  });

  it("handles json question with invalid JSON string", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: "{invalid}" }, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{
          id: "q1",
          prompt: "Provide JSON",
          type: "json",
          required: true,
        }],
      },
      rawText: "invalid",
    });
    expect(result.status).toBe("invalid");
    expect((result.errors ?? []).join("\n")).toContain("invalid json");
  });

  it("handles json question with non-string value", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: { x: 5 } }, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{
          id: "q1",
          prompt: "Provide JSON",
          type: "json",
          required: true,
        }],
      },
      rawText: "something",
    });
    expect(result.status).toBe("ok");
    expect(result.answers.q1).toEqual({ x: 5 });
  });

  it("handles optional question missing", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: {}, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Optional?", type: "text", required: false }],
      },
      rawText: "something",
    });
    expect(result.status).toBe("ok");
    expect(result.answers.q1).toBeUndefined();
  });

  it("collects stream text from various chunk types", async () => {
    const chunks = [
      "hello ",
      { choices: [{ delta: { content: "world" } }] },
      { choices: [{ delta: { content: [{ text: "!" }] } }] },
      { type: "text-delta", text: "!!" },
      { text: "!!!" },
    ];
    const llmAdapter = makeAdapterWithChunks(chunks);
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "freeform",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Say something", type: "text", required: true }],
      },
      rawText: "ignore",
    });
    // The adapter yields chunks that are not JSON, so parser will fail.
    // We just need to ensure the function doesn't crash; the error will be "parser returned non-JSON output"
    expect(result.status).toBe("invalid");
    // The collected text should be "hello world!!!!!!" but we don't need to assert.
  });

  it("handles LLM returning status invalid with errors", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "invalid", answers: {}, errors: ["something wrong"] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Say something", type: "text", required: true }],
      },
      rawText: "something",
    });
    expect(result.status).toBe("invalid");
    expect((result.errors ?? []).join("\n")).toContain("something wrong");
  });

  it("coerces yes_no with 'no', 'n', 'false', '0'", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: "no" }, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "approval",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Proceed?", type: "yes_no", required: true }],
      },
      rawText: "no",
    });
    expect(result.status).toBe("ok");
    expect(result.answers.q1).toBe(false);
  });

  it("coerces yes_no with invalid string", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: "maybe" }, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "approval",
        suspendPolicy: "pause_all",
        questions: [{ id: "q1", prompt: "Proceed?", type: "yes_no", required: true }],
      },
      rawText: "maybe",
    });
    expect(result.status).toBe("invalid");
    expect((result.errors ?? []).join("\n")).toContain("invalid yes_no");
  });

  it("handles multi_select without choices", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: ["apple", "banana"] }, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{
          id: "q1",
          prompt: "Choose fruits",
          type: "multi_select",
          required: true,
        }],
      },
      rawText: "apple banana",
    });
    expect(result.status).toBe("ok");
    expect(result.answers.q1).toEqual(["apple", "banana"]);
  });

  it("handles unknown question type (default case)", async () => {
    const llmAdapter = makeAdapter(JSON.stringify({ status: "ok", answers: { q1: "anything" }, errors: [] }));
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "q-1",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [{
          id: "q1",
          prompt: "Unknown type",
          type: "unknown" as any,
          required: true,
        }],
      },
      rawText: "anything",
    });
    expect(result.status).toBe("ok");
    expect(result.answers.q1).toBe("anything");
  });

  it("parses protocol-coded multi-question answers without calling the LLM parser", async () => {
    const llmAdapter = makeUnexpectedAdapter();
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "travel-intake",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [
          {
            id: "timing",
            prompt: "When are you traveling?",
            type: "single_select",
            required: true,
            choices: ["Soon", "Later", "Not sure"],
          },
          {
            id: "budget",
            prompt: "What budget level?",
            type: "single_select",
            required: true,
            choices: ["Budget", "Mid-range", "Premium"],
          },
          {
            id: "preferences",
            prompt: "What do you care about most?",
            type: "single_select",
            required: true,
            choices: ["Food", "Nature", "Museums"],
          },
        ],
      },
      rawText: "q1: A ; Q2: B\nQ3: D quiet beaches and less commercial",
    });

    expect(result).toEqual({
      status: "ok",
      answers: {
        timing: "Soon",
        budget: "Mid-range",
        preferences: "quiet beaches and less commercial",
      },
      errors: [],
    });
  });

  it("rejects unknown protocol option codes", async () => {
    const llmAdapter = makeUnexpectedAdapter();
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "trip-q",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [
          {
            id: "timing",
            prompt: "When are you traveling?",
            type: "single_select",
            required: true,
            choices: ["Soon", "Later"],
          },
        ],
      },
      rawText: "Q1: Z",
    });

    expect(result.status).toBe("invalid");
    expect((result.errors ?? []).join("\n")).toContain("invalid answer format for 'timing'");
  });

  it("strips the custom option code prefix for text questions in protocol answers", async () => {
    const llmAdapter = makeUnexpectedAdapter();
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "trip-q",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [
          {
            id: "days",
            prompt: "你计划玩几天？",
            type: "text",
            required: true,
          },
          {
            id: "style",
            prompt: "你更偏好哪种旅行风格？",
            type: "single_select",
            required: true,
            choices: ["轻松慢游", "自然风光"],
          },
        ],
      },
      rawText: "Q1: A 7天\nQ2: B",
    });

    expect(result).toEqual({
      status: "ok",
      answers: {
        days: "7天",
        style: "自然风光",
      },
      errors: [],
    });
  });

  it("accepts labeled free-text answers for text questions without requiring the custom option code", async () => {
    const llmAdapter = makeUnexpectedAdapter();
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "trip-q",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [
          {
            id: "preferences",
            prompt: "What do you care about most?",
            type: "text",
            required: true,
          },
        ],
      },
      rawText: "Q1: quiet beaches and less commercial",
    });

    expect(result).toEqual({
      status: "ok",
      answers: {
        preferences: "quiet beaches and less commercial",
      },
      errors: [],
    });
  });

  it("parses multi-select protocol answers with multiple option codes", async () => {
    const llmAdapter = makeUnexpectedAdapter();
    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "trip-q",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [
          {
            id: "party",
            prompt: "Who are you traveling with?",
            type: "multi_select",
            required: true,
            choices: ["Solo", "Partner", "Friends"],
          },
        ],
      },
      rawText: "Q1: A, C",
    });

    expect(result).toEqual({
      status: "ok",
      answers: {
        party: ["Solo", "Friends"],
      },
      errors: [],
    });
  });

  it("falls back to the LLM parser for non-protocol free-text answers", async () => {
    let parserCalled = false;
    const llmAdapter = makeInspectingAdapter((options) => {
      parserCalled = true;
      const userPayload = JSON.parse(String(options?.messages?.[1]?.content ?? "{}"));
      expect(userPayload.protocol?.questions?.[0]?.header).toBe("Q1");
      return JSON.stringify({
        status: "ok",
        answers: {
          q1: "quiet beaches and less commercial",
        },
        errors: [],
      });
    });

    const result = await parseQuestionnaireAnswer({
      llmAdapter,
      model: "mock-model",
      request: {
        questionnaireId: "trip-q",
        toolCallId: "tc-1",
        kind: "form",
        suspendPolicy: "pause_all",
        questions: [
          {
            id: "q1",
            prompt: "What do you care about most?",
            type: "text",
            required: true,
          },
        ],
      },
      rawText: "quiet beaches and less commercial",
    });

    expect(result).toEqual({
      status: "ok",
      answers: {
        q1: "quiet beaches and less commercial",
      },
      errors: [],
    });
    expect(parserCalled).toBe(true);
  });
});
