export type ImmutableJsonPrimitive = null | boolean | number | string;

export type ImmutableJsonArray = readonly ImmutableJsonValue[];

export type ImmutableJsonObject = {
  readonly [key: string]: ImmutableJsonValue;
};

export type ImmutableJsonValue =
  | ImmutableJsonPrimitive
  | ImmutableJsonArray
  | ImmutableJsonObject;

export type ActorRuntimeFacetEnvelope = Readonly<{
  facetId: string;
  schemaVersion: string;
  revision: number;
  value: ImmutableJsonValue;
}>;

export type ActorRuntimeFacetIndex = Readonly<
  Record<string, ActorRuntimeFacetEnvelope>
>;

/** Creation/import input. It is normalized to ActorRuntimeFacetIndex before use. */
export type ActorRuntimeFacetIndexInput =
  | readonly unknown[]
  | Readonly<Record<string, unknown>>;

export type ActorRuntimeFacetSelector = Readonly<{
  actorKey: string;
  facetId: string;
}>;

export type ActorRuntimeFacetReadInvocation = Readonly<{
  operationId: string;
  occurredAt: number;
}>;

export type ActorRuntimeFacetReplaceInvocation = Readonly<{
  expectedRevision: number;
  nextValue: unknown;
  reason: string;
}>;

export type ActorRuntimeFacetEvent =
  | Readonly<{
      kind: "beforeTurn";
      operationId: string;
      occurredAt: number;
    }>
  | Readonly<{
      kind: "aroundProvider";
      operationId: string;
      occurredAt: number;
      providerAttempt: number;
    }>
  | Readonly<{
      kind: "afterToolOutcome";
      operationId: string;
      occurredAt: number;
      toolCallId: string;
      toolName: string;
      recordDigest: string;
      isError: boolean;
      outcome: "completed" | "failed" | "cancelled";
      /** Domain-owned closed fact projected by a runtime-only codec hook. */
      ownerFact?: ImmutableJsonValue;
    }>;

export type ActorRuntimeFacetToolOutcomeProjectionInput = Readonly<{
  operationId: string;
  occurredAt: number;
  toolCallId: string;
  toolName: string;
  recordDigest: string;
  isError: boolean;
  outcome: "completed" | "failed" | "cancelled";
  /** Runtime-only transport from the terminal ToolCall owner; never persisted. */
  outputText: string;
}>;

export type ActorRuntimeFacetReplacementCandidate = Readonly<{
  expectedRevision: number;
  nextValue: unknown;
  reason: string;
}>;

export type ActorRuntimeFacetHookContext = Readonly<{
  selector: ActorRuntimeFacetSelector;
  envelope: ActorRuntimeFacetEnvelope;
  event: ActorRuntimeFacetEvent;
}>;

export type ActorRuntimeFacetHook = (
  context: ActorRuntimeFacetHookContext,
) => ActorRuntimeFacetReplacementCandidate | null;

/**
 * Invocation-scoped effect port. The provider continuation and abort effect
 * live here only; neither this port nor either function may be persisted or
 * smuggled through an event/config value.
 */
export type ActorRuntimeFacetProviderBoundaryPort<T> = Readonly<{
  run: () => Promise<T>;
  abort: (reason: string) => void;
}>;

export type ActorRuntimeFacetProviderBoundaryRuntime<T> = ActorRuntimeFacetVmRuntime & Readonly<{
  providerBoundary: ActorRuntimeFacetProviderBoundaryPort<T>;
}>;

export type ActorRuntimeFacetAroundProviderHook = <T>(
  context: ActorRuntimeFacetHookContext & Readonly<{
    event: Extract<ActorRuntimeFacetEvent, { kind: "aroundProvider" }>;
  }>,
  runtime: ActorRuntimeFacetProviderBoundaryRuntime<T>,
) => Promise<T>;

export type ActorRuntimeFacetCodecEntry = Readonly<{
  facetId: string;
  schemaVersion: string;
  normalize: (value: ImmutableJsonValue) => unknown;
  onEvent?: ActorRuntimeFacetHook;
  aroundProvider?: ActorRuntimeFacetAroundProviderHook;
  projectAfterToolOutcome?: (
    input: ActorRuntimeFacetToolOutcomeProjectionInput,
  ) => ImmutableJsonValue | undefined;
}>;

/** Runtime-only and per VM. Implementations must never serialize this value. */
export type ActorRuntimeFacetRegistry = Readonly<{
  entries: readonly ActorRuntimeFacetCodecEntry[];
  resolve: (
    facetId: string,
    schemaVersion: string,
  ) => ActorRuntimeFacetCodecEntry;
}>;

export type ActorRuntimeFacetProcessorConfig = Readonly<{
  maxValueDepth?: number;
}>;

export type ActorRuntimeFacetStateOwner = {
  key: string;
  runtimeFacets: ActorRuntimeFacetIndex;
};

export type ActorRuntimeFacetVmRuntime = Readonly<{
  actors: Record<string, ActorRuntimeFacetStateOwner>;
  runtimeContext: {
    actorFacetRuntime: ActorRuntimeFacetRegistry;
  };
}>;
