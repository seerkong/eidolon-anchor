import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import type { ChatCompletionsEffectBundle } from "@cell/ai-organ-contract";
import {
  deepSeekOfficialChatEffectBundle,
  openAIOfficialChatEffectBundle,
} from "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles";

function contractIdentity(bundle: ChatCompletionsEffectBundle): string {
  return bundle.id;
}

const repoRoot = path.resolve(import.meta.dir, "../../../../..");

function collectTypeScriptFiles(relativeDirectory: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      if (entry.isFile() && entry.name.endsWith(".ts")) files.push(entryPath);
    }
  };
  visit(path.join(repoRoot, relativeDirectory));
  return files;
}

describe("official Chat Completions effect bundle contract", () => {
  it("keeps contract ownership in ai-organ-contract and implementations in ai-organ-logic", () => {
    expect(contractIdentity(openAIOfficialChatEffectBundle)).toBe(
      "openai-official-chat",
    );
    expect(contractIdentity(deepSeekOfficialChatEffectBundle)).toBe(
      "deepseek-official-chat",
    );
    expect(openAIOfficialChatEffectBundle.streamCore).toBe(
      deepSeekOfficialChatEffectBundle.streamCore,
    );
  });

  it("projects official and explicitly configured endpoints", () => {
    expect(openAIOfficialChatEffectBundle.resolveEndpoint()).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(deepSeekOfficialChatEffectBundle.resolveEndpoint()).toBe(
      "https://api.deepseek.com/chat/completions",
    );
    expect(
      deepSeekOfficialChatEffectBundle.resolveEndpoint(
        "https://gateway.example/v9/",
      ),
    ).toBe("https://gateway.example/v9/chat/completions");
    expect(
      openAIOfficialChatEffectBundle.resolveEndpoint(
        "https://gateway.example/",
      ),
    ).toBe("https://gateway.example/v1/chat/completions");
    expect(
      openAIOfficialChatEffectBundle.resolveEndpoint(
        "https://api.deepseek.com",
      ),
    ).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(
      deepSeekOfficialChatEffectBundle.resolveEndpoint(
        "https://inferaiapi.com",
      ),
    ).toBe("https://inferaiapi.com/v1/chat/completions");
  });

  it("keeps DeepSeek compatibility fields out of OpenAI messages", () => {
    const request = openAIOfficialChatEffectBundle.projectRequest({
      model: "gpt-5",
      messages: [
        {
          role: "assistant",
          content: "answer",
          reasoning_content: "private reasoning",
          reasoning_details: [{ type: "reasoning.text", text: "private" }],
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_openai",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_openai", content: "ok" },
      ],
      tools: [],
      extraBody: { temperature: 0.2 },
    });

    expect(request).toMatchObject({
      model: "gpt-5",
      stream: true,
      temperature: 0.2,
    });
    expect(request).not.toHaveProperty("reasoning_split");
    expect(request.messages).toEqual([
      { role: "assistant", content: "answer" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_openai",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_openai", content: "ok" },
    ]);
  });

  it("preserves real DeepSeek reasoning and repairs only missing historical tool-call fields", () => {
    const messages = deepSeekOfficialChatEffectBundle.projectMessages([
      {
        role: "assistant",
        content: "answer",
        reasoningContent: "real reasoning",
      },
      {
        role: "assistant",
        content: "ordinary answer",
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_legacy",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_legacy", content: "ok" },
    ]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: "answer",
        reasoning_content: "real reasoning",
      },
      { role: "assistant", content: "ordinary answer" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "",
        tool_calls: [
          {
            id: "call_legacy",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_legacy", content: "ok" },
    ]);
  });

  it("applies distinct reasoning policies through the shared stream core", () => {
    const chunk = {
      choices: [{ delta: { reasoning_content: "inspect" } }],
    };
    const core = openAIOfficialChatEffectBundle.streamCore;
    const openAI = core.reduceChunk(
      core.createState(),
      chunk,
      openAIOfficialChatEffectBundle.streamReasoningPolicy,
    );
    const deepSeek = core.reduceChunk(
      core.createState(),
      chunk,
      deepSeekOfficialChatEffectBundle.streamReasoningPolicy,
    );

    expect(openAI.events).toEqual([]);
    expect(core.buildAssistantMessage(openAI.state)).not.toHaveProperty(
      "reasoning_content",
    );
    expect(deepSeek.events).toEqual([{ event: "think", data: "inspect" }]);
    expect(core.buildAssistantMessage(deepSeek.state)).toHaveProperty(
      "reasoning_content",
      "inspect",
    );
  });

  it("introduces no symbiont reverse dependency on the AI domain", () => {
    const offenders = [
      ...collectTypeScriptFiles("cell/packages/symbiont-contract/src"),
      ...collectTypeScriptFiles("cell/packages/symbiont-logic/src"),
    ]
      .filter((filePath) =>
        /@cell\/ai-organ-(contract|logic)/.test(
          fs.readFileSync(filePath, "utf8"),
        ),
      )
      .map((filePath) => path.relative(repoRoot, filePath));

    expect(offenders).toEqual([]);
  });
});
