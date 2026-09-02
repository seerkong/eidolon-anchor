import type {
  LlmProviderRuntime,
  ProviderChatCompatibilityProfileId,
} from "@cell/ai-organ-contract/llm/ProviderRuntime";

const PROFILE_IDS = new Set<ProviderChatCompatibilityProfileId>([
  "deepseek-chat@1",
  "deepseek-official-chat@1",
  "deepseek-compatible-chat@1",
]);

function parseProfileId(
  value: unknown,
): ProviderChatCompatibilityProfileId | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !PROFILE_IDS.has(value as ProviderChatCompatibilityProfileId)) {
    throw new Error("invalid_provider_chat_compatibility_profile");
  }
  return "deepseek-chat@1";
}

export function resolveSelectedProviderChatCompatibilityProfile(
  input: Readonly<{
    driverName: string;
    providerId: string;
    options: Readonly<Record<string, unknown>>;
    runtimeChatCompatibilityProfileId?: ProviderChatCompatibilityProfileId;
  }>,
): ProviderChatCompatibilityProfileId | undefined {
  if (input.driverName !== "deepseek-chat") return undefined;
  // Provider identity and configuration are routing facts, never protocol
  // authority. Legacy ids are accepted only to prove migration readability.
  parseProfileId(input.runtimeChatCompatibilityProfileId);
  return "deepseek-chat@1";
}

export function resolveProviderChatCompatibilityProfile(
  input: Readonly<{
    driverName: string;
    providerId: string;
    options: Readonly<Record<string, unknown>>;
  }>,
): ProviderChatCompatibilityProfileId | undefined {
  return resolveSelectedProviderChatCompatibilityProfile(input);
}

export function chatCompatibilityProfileId(
  runtime: LlmProviderRuntime,
): ProviderChatCompatibilityProfileId {
  return parseProfileId(runtime.chatCompatibilityProfileId) ?? (
    runtime.driverName === "deepseek-chat"
      ? "deepseek-chat@1"
      : (() => { throw new Error("invalid_provider_chat_compatibility_profile"); })()
  );
}
