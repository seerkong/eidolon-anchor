import { assembleRuntimeProfile } from "@cell/ai-composer";
import type {
  RuntimeAssemblyContext,
  RuntimeAssemblyResult,
  RuntimeBootstrapOptions,
  RuntimeExtension,
  RuntimeProfile,
} from "@cell/ai-composer/ai-contract";
import { applyModAiCoding, createCodingHookDefinitions } from "@cell/mod-ai-coding";
import { applyModAiKernel, createKernelHookDefinitions } from "@cell/mod-ai-kernel";
import { applyModPlatformKernel } from "@cell/mod-platform-kernel";

export const modPlatformKernelExtension: RuntimeExtension = {
  id: "mod-platform-kernel",
  kind: "platform",
  apply: applyModPlatformKernel,
};

export const modAiKernelExtension: RuntimeExtension = {
  id: "mod-ai-kernel",
  kind: "domain_kernel",
  hooks: createKernelHookDefinitions(),
  apply: applyModAiKernel,
};

export const modAiCodingExtension: RuntimeExtension = {
  id: "mod-ai-coding",
  kind: "app_overlay",
  hooks: createCodingHookDefinitions(),
  apply: applyModAiCoding,
};

function extendRuntimeProfile(id: string, baseProfile: RuntimeProfile, extensions: RuntimeExtension[]): RuntimeProfile {
  return {
    id,
    extensions: [...baseProfile.extensions, ...extensions],
  };
}

export const platformOnlyRuntimeProfile: RuntimeProfile = {
  id: "platform-only",
  extensions: [modPlatformKernelExtension],
};

export const aiKernelRuntimeProfile: RuntimeProfile = extendRuntimeProfile(
  "ai-kernel",
  platformOnlyRuntimeProfile,
  [modAiKernelExtension],
);

export const aiCodingRuntimeProfile: RuntimeProfile = extendRuntimeProfile(
  "ai-coding",
  aiKernelRuntimeProfile,
  [modAiCodingExtension],
);

export const modSysKernelExtension = modAiKernelExtension;
export const modSysCodingExtension = modAiCodingExtension;

export const runtimeProfilesById: Readonly<Record<string, RuntimeProfile>> = {
  [platformOnlyRuntimeProfile.id]: platformOnlyRuntimeProfile,
  [aiKernelRuntimeProfile.id]: aiKernelRuntimeProfile,
  [aiCodingRuntimeProfile.id]: aiCodingRuntimeProfile,
};

export function resolveRuntimeProfileById(profileId: string): RuntimeProfile {
  const profile = runtimeProfilesById[profileId];
  if (!profile) {
    throw new Error(
      `unknown runtime profile id: ${profileId} (available: ${Object.keys(runtimeProfilesById).join(", ")})`,
    );
  }
  return profile;
}

export function assemblePlatformOnlyRuntimeProfile(
  context: RuntimeAssemblyContext,
  options?: RuntimeBootstrapOptions,
): RuntimeAssemblyResult {
  return assembleRuntimeProfile(platformOnlyRuntimeProfile, context, options);
}

export function assembleAiKernelRuntimeProfile(
  context: RuntimeAssemblyContext,
  options?: RuntimeBootstrapOptions,
): RuntimeAssemblyResult {
  return assembleRuntimeProfile(aiKernelRuntimeProfile, context, options);
}

export function assembleAiCodingRuntimeProfile(
  context: RuntimeAssemblyContext,
  options?: RuntimeBootstrapOptions,
): RuntimeAssemblyResult {
  return assembleRuntimeProfile(aiCodingRuntimeProfile, context, options);
}
