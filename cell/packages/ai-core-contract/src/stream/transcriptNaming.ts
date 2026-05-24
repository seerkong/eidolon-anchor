export type TranscriptStageNamesData = {
  lexical: string;
  syntactic: string;
  semantic: string;
};

export type LexicalTranscriptStreamNamesData = {
  thinking_start: string;
  thinking_delta: string;
  thinking_end: string;
  content_start: string;
  content_delta: string;
  content_end: string;
  unquote_start: string;
  unquote_delta: string;
  unquote_end: string;
  tool_call_start: string;
  tool_call_delta: string;
  tool_call_end: string;
};

export type SyntacticTranscriptStreamNamesData = {
  thinking_start: string;
  thinking_delta: string;
  thinking_end: string;
  content_start: string;
  content_delta: string;
  content_end: string;
  quote: string;
  structured_node: string;
  tool_call: string;
  tool_text: string;
  error: string;
};

export type SemanticTranscriptStreamNamesData = {
  think_start: string;
  think_delta: string;
  think_end: string;
  content_start: string;
  content_delta: string;
  content_end: string;
  quote: string;
  tool_call_planned: string;
  tool_call_start: string;
  tool_call_result: string;
  notice: string;
  error: string;
};

export type TranscriptStreamNamesData = {
  lexical: LexicalTranscriptStreamNamesData;
  syntactic: SyntacticTranscriptStreamNamesData;
  semantic: SemanticTranscriptStreamNamesData;
};

export type TranscriptNamingData = {
  stages: TranscriptStageNamesData;
  streams: TranscriptStreamNamesData;
};

export function buildDefaultTranscriptNaming(): TranscriptNamingData {
  return {
    stages: {
      lexical: "lexical",
      syntactic: "syntactic",
      semantic: "semantic",
    },
    streams: {
      lexical: {
        thinking_start: "lexicalThinkingStart",
        thinking_delta: "lexicalThinkingDelta",
        thinking_end: "lexicalThinkingEnd",
        content_start: "lexicalContentStart",
        content_delta: "lexicalContentDelta",
        content_end: "lexicalContentEnd",
        unquote_start: "lexicalUnquoteStart",
        unquote_delta: "lexicalUnquoteDelta",
        unquote_end: "lexicalUnquoteEnd",
        tool_call_start: "lexicalToolCallStart",
        tool_call_delta: "lexicalToolCallDelta",
        tool_call_end: "lexicalToolCallEnd",
      },
      syntactic: {
        thinking_start: "syntacticThinkingStart",
        thinking_delta: "syntacticThinkingDelta",
        thinking_end: "syntacticThinkingEnd",
        content_start: "syntacticContentStart",
        content_delta: "syntacticContentDelta",
        content_end: "syntacticContentEnd",
        quote: "syntacticQuote",
        structured_node: "syntacticStructuredNode",
        tool_call: "syntacticToolCall",
        tool_text: "syntacticToolText",
        error: "syntacticError",
      },
      semantic: {
        think_start: "semanticThinkStart",
        think_delta: "semanticThinkDelta",
        think_end: "semanticThinkEnd",
        content_start: "semanticContentStart",
        content_delta: "semanticContentDelta",
        content_end: "semanticContentEnd",
        quote: "semanticQuote",
        tool_call_planned: "semanticToolCallPlanned",
        tool_call_start: "semanticToolCallStart",
        tool_call_result: "semanticToolCallResult",
        notice: "semanticNotice",
        error: "semanticError",
      },
    },
  };
}
