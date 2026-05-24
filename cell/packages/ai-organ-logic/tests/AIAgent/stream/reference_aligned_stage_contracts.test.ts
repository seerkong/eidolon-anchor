import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { buildDefaultTranscriptNaming } from "@cell/ai-core-contract/stream/transcriptNaming";
import { LEXICAL_EVENT_TYPES } from "@cell/ai-core-contract/stream/lexical";
import { SEMANTIC_EVENT_TYPES } from "@cell/ai-core-contract/stream/semantic";
import { SYNTACTIC_EVENT_TYPES } from "@cell/ai-core-contract/stream/syntactic";

describe("reference aligned stage contracts", () => {
  test("exposes exact lexical, syntactic, and semantic event names", () => {
    expect(LEXICAL_EVENT_TYPES).toEqual([
      "lexical_turn_start",
      "lexical_thinking_start",
      "lexical_thinking_delta",
      "lexical_thinking_end",
      "lexical_content_start",
      "lexical_content_delta",
      "lexical_content_end",
      "lexical_unquote_start",
      "lexical_unquote_delta",
      "lexical_unquote_end",
      "lexical_tool_call_start",
      "lexical_tool_call_delta",
      "lexical_tool_call_end",
      "lexical_usage",
      "lexical_stop",
      "lexical_error",
    ]);

    expect(SYNTACTIC_EVENT_TYPES).toEqual([
      "syntactic_thinking_start",
      "syntactic_thinking_delta",
      "syntactic_thinking_end",
      "syntactic_content_start",
      "syntactic_content_delta",
      "syntactic_content_end",
      "syntactic_tool_text",
      "syntactic_quote",
      "syntactic_structured_node",
      "syntactic_tool_call",
      "syntactic_error",
    ]);

    expect(SEMANTIC_EVENT_TYPES).toEqual([
      "semantic_user_input",
      "semantic_turn_start",
      "semantic_turn_end",
      "semantic_think_start",
      "semantic_think_delta",
      "semantic_think_end",
      "semantic_content_start",
      "semantic_content_delta",
      "semantic_content_end",
      "semantic_quote",
      "semantic_tool_call_planned",
      "semantic_tool_call_start",
      "semantic_tool_call_result",
      "semantic_questionnaire_request",
      "semantic_questionnaire_result",
      "semantic_actor_spawned",
      "semantic_actor_state",
      "semantic_mailbox_message",
      "semantic_inbox_snapshot",
      "semantic_task_state",
      "semantic_task_board",
      "semantic_plan_approval_request",
      "semantic_plan_approval_result",
      "semantic_shutdown_request",
      "semantic_shutdown_result",
      "semantic_background_result",
      "semantic_team_status",
      "semantic_notice",
      "semantic_error",
    ]);
  });

  test("uses transcript naming aligned to the reference project", () => {
    expect(buildDefaultTranscriptNaming()).toEqual({
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
    });
  });

  test("keeps new stage contracts isolated from removed legacy stream surface", () => {
    const repoRoot = path.resolve(import.meta.dir, "../../../../../..");
    const lexicalPath = path.join(repoRoot, "cell/packages/core-contract/src/stream/lexical.ts");
    const syntacticPath = path.join(repoRoot, "cell/packages/core-contract/src/stream/syntactic.ts");
    const semanticPath = path.join(repoRoot, "cell/packages/core-contract/src/stream/semantic.ts");
    const namingPath = path.join(repoRoot, "cell/packages/core-contract/src/stream/transcriptNaming.ts");
    const legacyPath = path.join(repoRoot, "cell/packages/core-contract/src/StreamEvents.ts");

    expect(fs.existsSync(lexicalPath)).toBe(true);
    expect(fs.existsSync(syntacticPath)).toBe(true);
    expect(fs.existsSync(semanticPath)).toBe(true);
    expect(fs.existsSync(namingPath)).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });
});
