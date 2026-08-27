import type {
  LlmProviderRuntime,
  ProviderChatCompatibilityProfileId,
} from "@cell/ai-organ-contract/llm/ProviderRuntime";

const PROFILE_IDS = new Set<ProviderChatCompatibilityProfileId>([
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
  return value as ProviderChatCompatibilityProfileId;
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
  const optionProfile = parseProfileId(input.options.compatibility_profile);
  const runtimeProfile = parseProfileId(
    input.runtimeChatCompatibilityProfileId,
  );
  if (optionProfile && runtimeProfile && optionProfile !== runtimeProfile) {
    throw new Error("provider_chat_compatibility_profile_conflict");
  }
  const selected = optionProfile ?? runtimeProfile;
  if (!selected) {
    throw new Error("provider_chat_compatibility_profile_required");
  }
  return selected;
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
  const profile = parseProfileId(runtime.chatCompatibilityProfileId);
  if (!profile) {
    throw new Error("invalid_provider_chat_compatibility_profile");
  }
  return profile;
}
