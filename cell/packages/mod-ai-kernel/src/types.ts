import type {
  DomainRuntimeAssemblyContext,
  DomainRuntimeAssemblyState,
} from "@cell/ai-core-contract";

export type RuntimeAssemblyContext = DomainRuntimeAssemblyContext & {
  workDir: string;
};

export type RuntimeAssemblyState = DomainRuntimeAssemblyState & {
  systemPromptSections: string[];
  capabilityIds: string[];
  policies: Readonly<Record<string, string>>;
};
