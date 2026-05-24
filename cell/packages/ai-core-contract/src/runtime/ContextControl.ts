export const WORK_MODES = {
  general_execution: "general_execution",
  localized_repair: "localized_repair",
  small_edit: "small_edit",
  focused_assignment: "focused_assignment",
  direct_lookup: "direct_lookup",
  docs_then_code: "docs_then_code",
  external_research: "external_research",
  long_running_coordination: "long_running_coordination",
} as const;

export type WorkMode = typeof WORK_MODES[keyof typeof WORK_MODES];

export const TASK_PHASES = {
  context_build: "context_build",
  context_build_then_code: "context_build_then_code",
  implementation: "implementation",
  verification: "verification",
  inspection_only: "inspection_only",
} as const;

export type TaskPhase = typeof TASK_PHASES[keyof typeof TASK_PHASES];

export type ActorWorkContextData = {
  workMode: WorkMode;
  taskPhase: TaskPhase;
  workModeSource: string;
  taskPhaseSource: string;
  workModeUpdatedAt: string;
  taskPhaseUpdatedAt: string;
  actorKey?: string;
  actorId?: string;
  sessionId?: string;
  lastTrigger?: string;
};

export type PromptRoutingDecisionData = {
  source: string;
  selectedCandidateIds: string[];
  rationale?: string | null;
  metadata?: Record<string, unknown>;
};

export type PromptPlanCacheProfileData = {
  providerFamily?: string;
  stablePrefixEnabled: boolean;
  providerManagedPrefixCache: boolean;
  preferLateCompaction: boolean;
  stablePrefixSections: string[];
  stablePrefixHash?: string;
  compactionThresholdTokens?: number;
};

export type PromptPlanData = {
  version: number;
  sessionId: string;
  actorKey: string;
  actorId: string;
  workContext: ActorWorkContextData;
  systemPrompts: string[];
  toolNames: string[];
  routingDecision: PromptRoutingDecisionData;
  cacheProfile?: PromptPlanCacheProfileData;
  metadata?: Record<string, unknown>;
};

export type CompactionMode = "auto" | "manual" | "micro";

export type CompactionPolicyContextData = {
  workMode: WorkMode;
  taskPhase: TaskPhase;
  trigger: string;
  mode: CompactionMode;
  tokensBefore: number;
  tokenThreshold: number;
  tokenPressure: number;
  modelFamily?: string;
  cachePolicy?: {
    stablePrefix?: boolean;
    providerManagedPrefixCache?: boolean;
    preferLateCompaction?: boolean;
    compactionThresholdTokens?: number;
  };
  baselineEpoch: number;
  messageCount: number;
  recentToolEvidenceCount: number;
  hasRecentPatchRationale: boolean;
  hasRecentVerificationTarget: boolean;
};

export type CompactionPolicyDecisionData = {
  policy: string;
  decision: "skip" | "summarize" | "rewrite";
  reason: string;
  workMode: WorkMode;
  taskPhase: TaskPhase;
  protectedCategories: string[];
  rewrittenCategories: string[];
  skipReason?: string | null;
};

export type ContinuationBaselineData = {
  baselineEpoch: number;
  lastResetReason?: string | null;
  latestResponseId?: string | null;
  updatedAt: string;
};
