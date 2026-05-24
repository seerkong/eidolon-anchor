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

export type RuntimeExtension<
  TState extends RuntimeAssemblyState = RuntimeAssemblyState,
  TContext extends RuntimeAssemblyContext = RuntimeAssemblyContext,
> = {
  id: string;
  apply: (state: TState, context: TContext) => TState;
};

export type RuntimeProfile<
  TState extends RuntimeAssemblyState = RuntimeAssemblyState,
  TContext extends RuntimeAssemblyContext = RuntimeAssemblyContext,
> = {
  id: string;
  extensions: RuntimeExtension<TState, TContext>[];
};
