import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"

import type {
  LocalConversationContextAssetData,
  LocalConversationContextResourceFact,
  LocalConversationContextResourceFragmentFact,
  LocalConversationContextResourceFragmentSelection,
} from "@cell/ai-organ-contract"
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import type { ContextResourcePresentationData } from "@cell/ai-core-contract/runtime/AiAgentVm"

import {
  getConversationSessionRawStateFromVm,
  materializeConversationRuntimeMessagesFromVm,
  upsertContextResourceFactToConversationDomainRuntime,
} from "../conversation/ConversationDomainRuntime"
import { getVmConversationDomainRuntime } from "../conversation/ConversationDomainRuntime"
import {
  computeTextResourceRevision,
  decideContextResourceLoad,
  type ContextResourceLoadDecision,
} from "./ContextResourceLoadDecision"
import { getVmToolCallDomain } from "./ToolCallDomainRuntime"

type LineRange = LocalConversationContextResourceFragmentSelection

export function recordContextResourcePresentation(params: {
  vm: AiAgentVm
  toolCallId?: string
  presentation: ContextResourcePresentationData
}): void {
  const toolCallId = String(params.toolCallId ?? "").trim()
  if (!toolCallId) return
  const runtimeContext = (params.vm as any)?.runtimeContext
  if (!runtimeContext) return
  runtimeContext.contextResourcePresentations ??= {}
  runtimeContext.contextResourcePresentations[toolCallId] = { ...params.presentation }
}

export function getContextResourcePresentation(
  vm: AiAgentVm,
  toolCallId: string,
): ContextResourcePresentationData | undefined {
  return (vm as any)?.runtimeContext?.contextResourcePresentations?.[String(toolCallId ?? "").trim()]
}

export type LocalTextResourceLoadInput = {
  vm: AiAgentVm
  actorKey: string
  actorId?: string
  toolCallId?: string
  fullPath: string
  canonicalResourceId?: string
  sourceText: string
  offset?: number
  limit?: number
  /** File size in bytes when the source is read from disk (Read tool); omitted for synthesized sources (Skill). */
  sizeBytes?: number
}

function rangeText(ranges: readonly LineRange[]): string {
  return ranges.map((range) => `${range.startLine}-${range.endLine}`).join(",")
}

export function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

function sizeAttribute(sizeBytes?: number): string {
  return typeof sizeBytes === "number" && Number.isFinite(sizeBytes) ? ` size-bytes="${sizeBytes}"` : ""
}

function totalLines(lines: string[]): number {
  return lines.length > 0 && lines.at(-1) === "" ? lines.length - 1 : lines.length
}

function digestText(text: string): { algorithm: "sha256"; digest: string } {
  return {
    algorithm: "sha256",
    digest: createHash("sha256").update(text).digest("hex"),
  }
}

function selectedText(lines: string[], ranges: readonly LineRange[]): string {
  return ranges
    .flatMap((range) => lines
      .slice(range.startLine - 1, range.endLine)
      .map((line, index) => `${range.startLine + index}: ${line}`))
    .join("\n")
}

function makeFragment(params: {
  revisionDigest: string
  range: LineRange
  lines: string[]
  observedAt: string
}): LocalConversationContextResourceFragmentFact {
  const selected = params.lines.slice(params.range.startLine - 1, params.range.endLine).join("\n")
  return {
    fragmentId: `${params.revisionDigest}:lines:${params.range.startLine}-${params.range.endLine}`,
    revisionDigest: params.revisionDigest,
    selection: params.range,
    contentDigest: digestText(selected),
    observedAt: params.observedAt,
  }
}

function findAsset(vm: AiAgentVm, canonicalResourceId: string): LocalConversationContextAssetData | undefined {
  if (!(vm as any)?.runtimeContext?.conversationDomainRuntime) return undefined
  return getConversationSessionRawStateFromVm({ vm })?.contextAssets?.find(
    (asset) => asset.resourceFact?.canonicalResourceId === canonicalResourceId,
  )
}

function decide(params: {
  vm: AiAgentVm
  actorKey: string
  fact: LocalConversationContextResourceFact | undefined
  revisionDigest: string
  requested: LineRange[]
}): ContextResourceLoadDecision | null {
  if (!(params.vm as any)?.runtimeContext?.conversationDomainRuntime) return null
  const domain = getVmToolCallDomain(params.vm)
  if (!params.fact || !domain) return null
  return decideContextResourceLoad({
    resourceFact: params.fact,
    currentRevisionDigest: params.revisionDigest,
    requestedRanges: params.requested,
    materializedMessages: materializeConversationRuntimeMessagesFromVm({
      vm: params.vm,
      actorKey: params.actorKey,
    }),
    toolCallRecords: domain.getAllRecords(),
  })
}

function persistDelivery(params: {
  input: LocalTextResourceLoadInput
  canonicalResourceId: string
  revision: { algorithm: "sha256"; digest: string }
  ranges: LineRange[]
  lines: string[]
  existing?: LocalConversationContextAssetData
}): void {
  if (!(params.input.vm as any)?.runtimeContext?.conversationDomainRuntime) return
  const runtime = getVmConversationDomainRuntime(params.input.vm)
  const session = getConversationSessionRawStateFromVm({ vm: params.input.vm })
  const toolCallId = String(params.input.toolCallId ?? "").trim()
  if (!runtime || !toolCallId || params.ranges.length === 0) return

  const observedAt = new Date().toISOString()
  const fragments = params.ranges.map((range) => makeFragment({
    revisionDigest: params.revision.digest,
    range,
    lines: params.lines,
    observedAt,
  }))
  const previousFact = params.existing?.resourceFact
  const previousFragments = previousFact?.fragments ?? []
  const previousDeliveries = previousFact?.deliveries ?? []
  const fragmentMap = new Map(previousFragments.map((fragment) => [fragment.fragmentId, fragment]))
  for (const fragment of fragments) fragmentMap.set(fragment.fragmentId, fragment)
  const resourceFact: LocalConversationContextResourceFact = {
    canonicalResourceId: params.canonicalResourceId,
    revision: params.revision,
    fragments: [...fragmentMap.values()],
    deliveries: [
      ...previousDeliveries,
      ...fragments.map((fragment) => ({
        toolCallId,
        revisionDigest: params.revision.digest,
        fragmentId: fragment.fragmentId,
        deliveredAt: observedAt,
      })),
    ],
    observedAt,
  }
  const assetId = params.existing?.assetId
    ?? `workspace-resource-${createHash("sha256").update(params.canonicalResourceId).digest("hex").slice(0, 16)}`
  const asset: LocalConversationContextAssetData = {
    ...(params.existing ?? {}),
    assetId,
    kind: "workspace_file",
    label: params.existing?.label ?? params.input.fullPath,
    source: params.existing?.source ?? { kind: "workspace_file", path: params.input.fullPath },
    resourceFact,
    createdAt: params.existing?.createdAt ?? observedAt,
    updatedAt: observedAt,
  }
  upsertContextResourceFactToConversationDomainRuntime({
    runtime,
    sessionId: session?.sessionId
      ?? String((params.input.vm.outerCtx?.metadata as any)?.sessionId ?? "__unsessioned__"),
    asset,
    occurredAt: observedAt,
  })
}

export function loadLocalTextResource(input: LocalTextResourceLoadInput): string {
  const offset = Number(input.offset ?? 1)
  const limit = Number(input.limit ?? 2000)
  if (!Number.isFinite(offset) || !Number.isFinite(limit) || offset < 1 || limit < 1) {
    return "Error: read line offset and limit must be positive finite numbers"
  }
  const startLine = Math.floor(offset)
  const requestedLimit = Math.floor(limit)
  const lines = input.sourceText.split(/\r?\n/)
  const endLine = Math.min(lines.length, startLine + requestedLimit - 1)
  const canonicalResourceId = input.canonicalResourceId ?? pathToFileURL(input.fullPath).href
  const revision = computeTextResourceRevision(input.sourceText)
  if (startLine > lines.length) {
    recordContextResourcePresentation({
      vm: input.vm,
      toolCallId: input.toolCallId,
      presentation: {
        status: "loaded",
        resourceId: canonicalResourceId,
        revision: revision.digest,
        totalLines: totalLines(lines),
        sizeBytes: input.sizeBytes,
        requestedLines: `${startLine}-${endLine}`,
        deliveredLines: "",
      },
    })
    return `<context-resource status="loaded" resource-id="${escapeAttribute(canonicalResourceId)}" revision="${revision.digest}" total-lines="${totalLines(lines)}"${sizeAttribute(input.sizeBytes)} requested-lines="${startLine}-${endLine}" delivered-lines=""></context-resource>`
  }

  const requested: LineRange[] = [{ kind: "line_range", startLine, endLine }]
  const existing = findAsset(input.vm, canonicalResourceId)
  const decision = decide({
    vm: input.vm,
    actorKey: input.actorKey,
    fact: existing?.resourceFact,
    revisionDigest: revision.digest,
    requested,
  })
  if (decision?.kind === "already_visible") {
    const recoveryLine = decision.recoveryPaths.length > 0
      ? `\nFull output persisted at: ${decision.recoveryPaths.join(", ")}`
      : "";
    recordContextResourcePresentation({
      vm: input.vm,
      toolCallId: input.toolCallId,
      presentation: {
        status: "already-visible",
        resourceId: canonicalResourceId,
        revision: revision.digest,
        totalLines: totalLines(lines),
        sizeBytes: input.sizeBytes,
        requestedLines: rangeText(requested),
      },
    })
    return `<context-resource status="already-visible" resource-id="${escapeAttribute(canonicalResourceId)}" revision="${revision.digest}" total-lines="${totalLines(lines)}"${sizeAttribute(input.sizeBytes)} requested-lines="${rangeText(requested)}"></context-resource>${recoveryLine}`
  }

  const delivered = decision?.missingRanges ?? requested
  const body = selectedText(lines, delivered)
  persistDelivery({ input, canonicalResourceId, revision, ranges: delivered, lines, existing })
  recordContextResourcePresentation({
    vm: input.vm,
    toolCallId: input.toolCallId,
    presentation: {
      status: "loaded",
      resourceId: canonicalResourceId,
      revision: revision.digest,
      totalLines: totalLines(lines),
      sizeBytes: input.sizeBytes,
      requestedLines: rangeText(requested),
      deliveredLines: rangeText(delivered),
      contentText: body,
    },
  })
  return [
    `<context-resource status="loaded" resource-id="${escapeAttribute(canonicalResourceId)}" revision="${revision.digest}" total-lines="${totalLines(lines)}"${sizeAttribute(input.sizeBytes)} requested-lines="${rangeText(requested)}" delivered-lines="${rangeText(delivered)}">`,
    body,
    "</context-resource>",
  ].filter((part) => part !== "").join("\n")
}
