export type ProviderStreamTimeoutProfile = {
  defaultTimeoutSeconds: number;
  defaultFirstEventTimeoutSeconds: number;
  defaultIdleTimeoutSeconds: number;
  adaptiveTimeoutMaxSeconds?: number | null;
  adaptiveTimeoutCharThreshold?: number;
  adaptiveTimeoutCharStep?: number;
  adaptiveTimeoutStepSeconds?: number;
  adaptiveTimeoutToolThreshold?: number;
  adaptiveTimeoutToolStep?: number;
  adaptiveTimeoutToolStepSeconds?: number;
  adaptiveFirstEventTimeoutMaxSeconds?: number | null;
  adaptiveFirstEventTimeoutCharThreshold?: number;
  adaptiveFirstEventTimeoutCharStep?: number;
  adaptiveFirstEventTimeoutStepSeconds?: number;
  adaptiveFirstEventTimeoutToolThreshold?: number;
  adaptiveFirstEventTimeoutToolStep?: number;
  adaptiveFirstEventTimeoutToolStepSeconds?: number;
};

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function positiveStepCount(value: number, threshold = 0, step = 0): number {
  if (step <= 0 || value <= threshold) return 0;
  return Math.ceil((value - threshold) / step);
}

export function estimateProviderMessageChars(messages: Array<{ content?: unknown }> = []): number {
  let total = 0;
  for (const message of messages) {
    total += String(message?.content ?? "").length;
  }
  return total;
}

export function resolveTimeoutSeconds(
  requestOptions: Record<string, unknown>,
  params: { profile: ProviderStreamTimeoutProfile; system?: string; messages?: Array<{ content?: unknown }>; tools?: unknown[] },
): number {
  return numberOrUndefined(requestOptions.timeout) ?? resolveAdaptiveTimeoutSeconds(params);
}

export function resolveFirstEventTimeoutSeconds(
  requestOptions: Record<string, unknown>,
  params: { profile: ProviderStreamTimeoutProfile; system?: string; messages?: Array<{ content?: unknown }>; tools?: unknown[] },
): number {
  return (
    numberOrUndefined(requestOptions.first_event_timeout_seconds) ??
    numberOrUndefined(requestOptions.first_event_timeout) ??
    resolveAdaptiveFirstEventTimeoutSeconds(params)
  );
}

export function resolveStreamIdleTimeoutSeconds(
  requestOptions: Record<string, unknown>,
  params: { profile: ProviderStreamTimeoutProfile },
): number {
  return (
    numberOrUndefined(requestOptions.stream_idle_timeout_seconds) ??
    numberOrUndefined(requestOptions.stream_idle_timeout) ??
    params.profile.defaultIdleTimeoutSeconds
  );
}

export function resolveAdaptiveTimeoutSeconds(params: {
  profile: ProviderStreamTimeoutProfile;
  system?: string;
  messages?: Array<{ content?: unknown }>;
  tools?: unknown[];
}): number {
  const profile = params.profile;
  const messageChars = estimateProviderMessageChars(params.messages ?? []) + String(params.system ?? "").length;
  const toolCount = params.tools?.length ?? 0;
  let timeout = profile.defaultTimeoutSeconds;
  timeout += positiveStepCount(
    messageChars,
    profile.adaptiveTimeoutCharThreshold ?? 0,
    profile.adaptiveTimeoutCharStep ?? 0,
  ) * (profile.adaptiveTimeoutStepSeconds ?? 0);
  timeout += positiveStepCount(
    toolCount,
    profile.adaptiveTimeoutToolThreshold ?? 0,
    profile.adaptiveTimeoutToolStep ?? 0,
  ) * (profile.adaptiveTimeoutToolStepSeconds ?? 0);
  return profile.adaptiveTimeoutMaxSeconds == null ? timeout : Math.min(profile.adaptiveTimeoutMaxSeconds, timeout);
}

export function resolveAdaptiveFirstEventTimeoutSeconds(params: {
  profile: ProviderStreamTimeoutProfile;
  system?: string;
  messages?: Array<{ content?: unknown }>;
  tools?: unknown[];
}): number {
  const profile = params.profile;
  const messageChars = estimateProviderMessageChars(params.messages ?? []) + String(params.system ?? "").length;
  const toolCount = params.tools?.length ?? 0;
  let timeout = profile.defaultFirstEventTimeoutSeconds;
  timeout += positiveStepCount(
    messageChars,
    profile.adaptiveFirstEventTimeoutCharThreshold ?? 0,
    profile.adaptiveFirstEventTimeoutCharStep ?? 0,
  ) * (profile.adaptiveFirstEventTimeoutStepSeconds ?? 0);
  timeout += positiveStepCount(
    toolCount,
    profile.adaptiveFirstEventTimeoutToolThreshold ?? 0,
    profile.adaptiveFirstEventTimeoutToolStep ?? 0,
  ) * (profile.adaptiveFirstEventTimeoutToolStepSeconds ?? 0);
  return profile.adaptiveFirstEventTimeoutMaxSeconds == null
    ? timeout
    : Math.min(profile.adaptiveFirstEventTimeoutMaxSeconds, timeout);
}
