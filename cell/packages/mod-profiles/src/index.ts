import { assembleRuntimeProfile } from "@cell/ai-composer";
import type {
  RuntimeAssemblyContext,
  RuntimeAssemblyResult,
  RuntimeBootstrapOptions,
  RuntimeExtension,
  RuntimeProfile,
} from "@cell/ai-composer/ai-contract";
import { applyModAiCoding } from "@cell/mod-ai-coding";
import { applyModAiKernel } from "@cell/mod-ai-kernel";
import { applyModPlatformKernel } from "@cell/mod-platform-kernel";

export const modPlatformKernelExtension: RuntimeExtension = {
  id: "mod-platform-kernel",
  apply: applyModPlatformKernel,
};

export const modAiKernelExtension: RuntimeExtension = {
  id: "mod-ai-kernel",
  apply: applyModAiKernel,
};

export const modAiCodingExtension: RuntimeExtension = {
  id: "mod-ai-coding",
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
