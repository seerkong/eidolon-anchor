export { spawnChildExecutionActor } from "./agent/DelegateActor";
export { forceCompressActorHistory } from "./exec/AiAgentExecutor";
export {
  createAiAgentOrchestratorDriver,
  createAiAgentOrchestratorDriverWithCooperative,
} from "./OrchestratorDriver";

export {
  bridgeIngressStreamsToGraph,
  createIngressStreamAdapter,
  createMockOpenAI,
  createSemanticProtocolBinding,
  createSemanticStreamPipeline,
  SemanticStreamGraph,
} from "./stream";
export {
  AnthropicNodejsFetchLlmAdapter,
  ClaudeNodejsFetchLlmAdapter,
  defaultProviderConfigPath,
  extractProviderOptions,
  flattenModelConfig,
  isModelRefResolvable,
  isPersistedModelStillResolvable,
  loadProviderConfig,
  loadProviderCatalog,
  loadPresentConfig,
  normalizeModelOptions,
  OpenAICompletionsNodejsFetchLlmAdapter,
  OpenAIResponsesNodejsFetchLlmAdapter,
  PROVIDER_CONFIG_FILE_NAME,
  ProviderRuntimeLlmAdapter,
  refreshProviderTransportMarkers,
  resolveActorModelConfig,
  resolvePresetModelRef,
  resolvePrimaryCandidates,
  type LlmAdapterType,
} from "./llm";
export { loadMcpServers, MCPManager, setDebug } from "./mcp/McpSupport";

export { getMemberManager } from "./organization/MemberManager";
export {
  createEmptyConversationProjection,
  reduceConversationDomainEvent,
  reduceConversationDomainEvents,
} from "./conversation/ConversationDomainProjection";
export { loadConversationDebugSnapshot } from "./conversation/ConversationDebug";
export {
  applyPromptTransformToConversationDomainRuntime,
  appendConversationDomainEvent,
  appendLiveHistoryMessageToConversationDomainRuntime,
  clearContextBlocksInConversationDomainRuntime,
  closeConversationSessionInConversationDomainRuntime,
  createConversationDomainRuntime,
  ensureVmConversationDomainRuntime,
  emitConversationDomainEvent,
  forkConversationSessionInConversationDomainRuntime,
  getConversationActorRawStateFromVm,
  getConversationSessionRawStateFromVm,
  getVmConversationDomainRuntime,
  injectConversationActorRawState,
  injectConversationSessionRawState,
  materializeConversationHistoryMessagesFromVm,
  materializeConversationRuntimeMessagesFromVm,
  recordConversationTranscriptEvidenceInRuntime,
  recordPromptOverlayToConversationDomainRuntime,
  recordPromptRequestToConversationDomainRuntime,
  registerContextBlockToConversationDomainRuntime,
  setConversationDomainPersistHooks,
  subscribeConversationHistory,
  subscribeConversationPrompt,
  subscribeConversationSession,
  synchronizeConversationDomainActorFromPersistence,
  synchronizeConversationDomainSessionFromPersistence,
  teeConversationHistoryStream,
  teeConversationPromptStream,
  teeConversationSessionStream,
  updateConversationDomainFromTranscriptRecordBatch,
} from "./conversation/ConversationDomainRuntime";
export {
  configureRuntimePersistenceSupport,
  hasRuntimeSnapshot,
  recoverAiAgentRuntime,
  saveAiAgentRuntimeSnapshot,
  sealCompletedConversationProgress,
} from "./persistence/RuntimeSnapshots";
export {
  createRecoveryReadPort,
  assertConversationRecoverySourceComplete,
  type RuntimeRecoveryReadPort,
} from "./persistence/RecoveryReadPort";
export { configureLocalPermissionConfigStore } from "./permissions/LocalPermissionConfig";
export { createAiAgentRuntimeCoordinator } from "./runtime/AiAgentRuntimeCoordinator";
export { isTerminalTurnState, turnReducer } from "./runtime/TurnReducer";
export {
  createToolCallDomainRuntime,
  ensureVmToolCallDomain,
  getVmToolCallDomain,
  restoreVmToolCallDomain,
  reconstructToolResultsFromDomain,
  type ToolCallDomainRuntime,
} from "./runtime/ToolCallDomainRuntime";
export {
  createProviderCallDomainRuntime,
  ensureVmProviderCallDomain,
  getVmProviderCallDomain,
  restoreVmProviderCallDomain,
  getProviderReasoningFact,
  getProviderContentFact,
  getLatestActorProviderReasoning,
  type ProviderCallDomainRuntime,
} from "./runtime/ProviderCallDomainRuntime";
export {
  advanceActorWorkContextAfterTool,
  buildCompactionPolicyContextForActor,
  buildPromptPlanForActorExecution,
  buildWorkContextOverlayText,
  decideCompactionPolicy,
  getActorContinuationBaseline,
  getActorContinuationBaselineFromVm,
  getActorWorkContext,
  getActorWorkContextFromVm,
  materializeExecutionMessagesWithWorkContext,
  normalizeTaskPhase,
  normalizeWorkMode,
  recordPromptPlanForActorExecution,
  resetActorContinuationBaseline,
  resolveWorkModeToolGuidance,
  resolveTurnWorkContextForActor,
  setActorTaskPhase,
  setActorWorkMode,
} from "./runtime/ContextControlPlane";
export { createShellRuntimeFacade } from "./runtime/ShellRuntimeFacade";
export {
  createRuntimeLlmAdapter,
  emitRuntimeDirectSlashAssistantOutput,
  processRuntimeIngressStream,
} from "./runtime/ShellRuntimeSupport";
export {
  bindIngressStreamsToSessionXnlLog,
  createSessionDiagnosticsXnlLog,
} from "./runtime/SessionRuntimeXnlLogs";
export {
  bindObservabilitySinks,
  createLogObservabilitySink,
  createObservabilityRxData,
  createProviderSceneCaptureHook,
  createSessionTraceArtifactSink,
  emitExtensionObservabilityFact,
  emitObservabilityRecord,
  emitSemanticObservabilityRecord,
  providerSceneToObservabilityRecord,
  semanticEventToObservabilityRecord,
} from "./observability/ObservabilityRx";
export {
  createDiagnosticPipeline,
  createDiagnosticSubgraph,
  SceneStore,
  SceneRecorder,
  SceneReplay,
  manifestToNode,
  nodeToManifest,
  messageToNode,
  nodeToMessage,
  observableGraphMiddleware,
  createObservableGraph,
  createSessionTraceSink,
  sessionTraceExportXnl,
  sessionTraceImportFile,
} from "./observability";
export type {
  DiagnosticPipeline,
  DiagnosticPipelineOptions,
  DiagnosticPipelineStats,
  PipelineRecord,
} from "./observability/DiagnosticPipeline";
export type {
  DiagnosticSubgraph,
  DiagnosticModule,
  DiagnosticSummary,
  ModelSelectionSignal,
  ContinuationSignal,
  TurnTimingEntry,
  CompactionEntry,
  ToolCallEntry,
  RetryEntry,
} from "./observability/DiagnosticSubgraph";
export type {
  SceneRecorderOptions,
} from "./observability/SceneRecorder";
export type {
  ReplayTurn,
  ReplayDiff,
  SceneReplayOptions,
} from "./observability/SceneReplay";
export type {
  ToolDef,
  SceneManifest,
  SceneMessage,
  SceneToolCall,
} from "./observability/SceneTypes";
export type {
  ObservableGraphMiddlewareOptions,
} from "./observability/ObservableGraphMiddleware";
export type {
  ObservableGraph,
  ObservableGraphOptions,
} from "./observability/createObservableGraph";
export type {
  SessionTraceSinkOptions,
} from "./observability/SessionTraceSink";
export {
  configureShellRuntimeEffects,
  createShellRuntimePaths,
  ensureShellRuntimeSessionDir,
  recoverOrCreateShellRuntime,
} from "./runtime/ShellRuntimeBootstrap";
export { tickAiAgentRuntimeBackground } from "./runtime/tickAiAgentRuntimeBackground";
export {
  createRuntimeHookDispatcher,
  createRuntimeHookHandlerComponent,
} from "./hooks/RuntimeHookDispatcher";
export {
  createDefaultRuntimeHookHandlers,
} from "./hooks/DefaultRuntimeHookHandlers";
export {
  runRuntimeLifecycleHook,
} from "./hooks/RuntimeHookProducer";
export type {
  RuntimeHookDispatcher,
  RuntimeHookDispatcherOptions,
  RuntimeHookDispatchOutput,
  RuntimeHookDispatchParams,
  RuntimeHookHandlerComponent,
  RuntimeHookHandlerRuntime,
} from "./hooks/RuntimeHookDispatcher";
export type {
  RuntimeLifecycleHookParams,
} from "./hooks/RuntimeHookProducer";
export { LLMSemanticProjector } from "./stream/semantic/LLMSemanticProjector";
export type {
  RuntimeAdapterOverrides,
  RuntimeLlmAdapterDefaults,
  RuntimeLlmAdapterFactoryOverride,
} from "./runtime/ShellRuntimeSupport";
export type {
  RecoverOrCreateShellRuntimeParams,
  RecoverOrCreateShellRuntimeResult,
  ShellRuntimeActorCallbacks,
  ShellRuntimeEffects,
  ShellRuntimePaths,
} from "./runtime/ShellRuntimeBootstrap";
export type {
  ShellRuntimeActorIdentity,
  ShellRuntimeCoordinationPayload,
  ShellRuntimeDetachedActorDonePayload,
  ShellRuntimeEventRouting,
  ShellRuntimeFacade,
} from "./runtime/ShellRuntimeFacade";
