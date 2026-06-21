export type RuntimePolicyMap = Readonly<Record<string, string>>;

export type RuntimeAssemblyContext = {
  workDir: string;
};

export type RuntimeBootstrapOptions = {
  includeInternalOnly?: boolean;
};

export type RuntimeAssemblyState = {
  systemPromptSections: string[];
  capabilityIds: string[];
  policies: RuntimePolicyMap;
};

export type RuntimeAssemblyResult = {
  profileId: string;
  systemPrompt: string;
  capabilityIds: string[];
  policies: RuntimePolicyMap;
};

export type RuntimeExtensionKind = "platform" | "domain_kernel" | "app_overlay";

export type RuntimeExtension<
  TState extends RuntimeAssemblyState = RuntimeAssemblyState,
  TContext extends RuntimeAssemblyContext = RuntimeAssemblyContext,
> = {
  id: string;
  /** Architecture layer of this extension; extensions without a kind count as platform baseline. */
  kind?: RuntimeExtensionKind;
  apply: (state: TState, context: TContext) => TState;
};

export type RuntimeProfile<
  TState extends RuntimeAssemblyState = RuntimeAssemblyState,
  TContext extends RuntimeAssemblyContext = RuntimeAssemblyContext,
> = {
  id: string;
  extensions: RuntimeExtension<TState, TContext>[];
};

export type RuntimeEntryType = "cli" | "tui" | "headless";

export type RuntimeStorageCapabilityFlags = {
  logs: boolean;
  files: boolean;
};

/**
 * Testable output of runtime composition. Entries select a profile, an entry
 * type, storage flags, and surface capabilities; everything else is derived
 * from the profile. Two descriptors built from the same profile and storage
 * flags must be compatible regardless of entry type.
 */
export type RuntimeBindingDescriptor = {
  profileId: string;
  entryType: RuntimeEntryType;
  enabledCapabilities: string[];
  storage: RuntimeStorageCapabilityFlags;
  platformModules: string[];
  domainKernelModules: string[];
  appOverlays: string[];
  surfaceCapabilities: string[];
};
