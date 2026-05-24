import type { ProviderDriverDefinition } from "@cell/ai-organ-contract/llm/ProviderRuntime";
import { buildAnthropicProviderDriver } from "./drivers/AnthropicDriver";
import { buildClaudeCodeProviderDriver } from "./drivers/ClaudeCodeDriver";
import { buildDeepSeekProviderDriver } from "./drivers/DeepSeekDriver";
import { buildOpenAIChatProviderDriver } from "./drivers/OpenAIChatDriver";
import { buildOpenAIResponsesProviderDriver } from "./drivers/OpenAIResponsesDriver";

export function buildProviderDriverRegistry(): Record<string, ProviderDriverDefinition> {
  const definitions = [
    buildAnthropicProviderDriver(),
    buildClaudeCodeProviderDriver(),
    buildDeepSeekProviderDriver(),
    buildOpenAIChatProviderDriver(),
    buildOpenAIResponsesProviderDriver(),
  ];
  return Object.fromEntries(definitions.map((definition) => [definition.name, definition]));
}

export function getProviderDriver(adapterName: string): ProviderDriverDefinition {
  const normalized = String(adapterName || "").trim().toLowerCase();
  for (const definition of Object.values(buildProviderDriverRegistry())) {
    if (definition.adapterNames.includes(normalized)) return definition;
  }
  throw new Error(`Unknown provider driver adapter: ${adapterName}`);
}
