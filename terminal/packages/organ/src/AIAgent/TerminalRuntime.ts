import {
  createSessionRuntimeAssembly,
  normalizeSessionRuntimeMetadata,
  type SessionRuntimeConfig,
  type SessionRuntimeBridge,
  type RuntimeBridgeInitStatus,
  type SessionProviderCollector,
} from "@cell/ai-runtime-host-capsule/session/SessionRuntimeAssembly"
import { openStandaloneHolonSessionExtension } from "@cell/ai-runtime-host-capsule/session/StandaloneHolonSessionExtension"
import { createHostResourceEffects } from "@cell/ai-runtime-host-support"
import { SemanticTerminalRuntimeBridge } from "../stream/SemanticTerminalRuntimeBridge"
import { isWatchedOrganizationProjection } from "./OrganizationWatchProjection"

export {
  resolveRuntimeAuthorityRoot,
  resolveRuntimeWorkflowRoots,
  resolveRuntimeResourcePackageLayers,
  normalizeSessionRuntimeMetadata as normalizeTerminalRuntimeMetadata,
  buildExecRuntimeMetadata,
  resolveSessionRuntimeBindingFromConfig as resolveTerminalRuntimeBindingFromConfig,
  composeSessionRuntimeBinding as composeTerminalRuntimeBinding,
  drainHeartbeatFiredSchedules,
  __setLlmAdapterFactoryForTest,
  __setRuntimeAssemblyFactoryForTest,
  __sendRuntimeMemberInboxForTest,
  __sendRuntimeCoordinationForTest,
  __emitRuntimeDetachedActorDoneForTest,
  __emitAsyncRuntimeDetachedActorDoneForTest,
  buildSystemMessages,
} from "@cell/ai-runtime-host-capsule/session/SessionRuntimeAssembly"
export type {
  RuntimeBridgeNotification,
  RuntimeActiveModelSelection,
  RuntimeBridgeHistoryEvent,
  RuntimeBridgeInitStatus,
  ProviderRequestObservationBindingContext,
  ProviderRequestObservationBinding,
  ProviderRequestObservationBindingFactory,
  SessionRuntimeBindingInput as TerminalRuntimeBindingInput,
  SessionRuntimeBinding as TerminalRuntimeBinding,
} from "@cell/ai-runtime-host-capsule/session/SessionRuntimeAssembly"

export type TuiRuntimeConfig = SessionRuntimeConfig
export type TuiRuntimeBridge = SessionRuntimeBridge
export type TerminalRuntimeConfig = SessionRuntimeConfig
export type TerminalRuntimeBridge = SessionRuntimeBridge

type Projection = "content" | "textual"
type InitOptions = { onInitStatus?: (status: RuntimeBridgeInitStatus) => void }
let runtimeConfig: SessionRuntimeConfig = { workDir: process.cwd(), mcp: true, ephemeral: false }
const sessionRuntimePromises = new Map<string, Promise<SessionRuntimeBridge | null>>()
const toolResources = createHostResourceEffects()
let providerCollector: SessionProviderCollector | null = null

export function configureProviderCollector(collector: SessionProviderCollector | null): void {
  providerCollector = collector
}

function getRuntimeBridge(sessionKey: string, projection: Projection, options?: InitOptions) {
  const cacheKey = `${projection}:${sessionKey}`
  const existing = sessionRuntimePromises.get(cacheKey)
  if (existing) return existing
  const created = createSessionRuntimeAssembly({
    sessionKey,
    config: { ...runtimeConfig },
    toolResources,
    providerCollector,
    onInitStatus: options?.onInitStatus,
    openExtension: openStandaloneHolonSessionExtension,
    additionalWatchedProjection: isWatchedOrganizationProjection,
    presentationFactory: () => {
      const bridge = new SemanticTerminalRuntimeBridge()
      return {
        consumeSemanticEvent: (event) => bridge.consumeSemanticEvent(event),
        onEvent: (handler) => projection === "textual" ? bridge.onTextualEvent(handler) : bridge.onTuiEvent(handler),
        dispose: () => bridge.dispose(),
      }
    },
  })
  sessionRuntimePromises.set(cacheKey, created)
  return created
}

async function disposeRuntimeBridge(sessionKey: string, projection: Projection) {
  const cacheKey = `${projection}:${sessionKey}`
  const pending = sessionRuntimePromises.get(cacheKey)
  sessionRuntimePromises.delete(cacheKey)
  await (await pending?.catch(() => null))?.dispose()
}

export function getTuiRuntimeBridge(sessionKey: string, options?: InitOptions) {
  return getRuntimeBridge(sessionKey, "content", options)
}
export function getTextualRuntimeBridge(sessionKey: string, options?: InitOptions) {
  return getRuntimeBridge(sessionKey, "textual", options)
}
export function disposeTuiRuntimeBridge(sessionKey: string) {
  return disposeRuntimeBridge(sessionKey, "content")
}
export function disposeTextualRuntimeBridge(sessionKey: string) {
  return disposeRuntimeBridge(sessionKey, "textual")
}
export function configureTuiRuntime(config: TuiRuntimeConfig) {
  const pending = [...sessionRuntimePromises.values()]
  runtimeConfig = { ...config, ephemeral: config.ephemeral === true, metadata: normalizeSessionRuntimeMetadata(config.workDir, config.metadata, config.globalRoot) }
  sessionRuntimePromises.clear()
  for (const runtime of pending) void runtime.then((bridge) => bridge?.dispose()).catch(() => {})
}

export const getSessionRuntimeBridge = getTuiRuntimeBridge
export const disposeSessionRuntimeBridge = disposeTuiRuntimeBridge
export const configureSessionRuntime = configureTuiRuntime
export const getTerminalRuntimeBridge = getTextualRuntimeBridge
export const disposeTerminalRuntimeBridge = disposeTextualRuntimeBridge
export const configureTerminalRuntime = configureTuiRuntime
