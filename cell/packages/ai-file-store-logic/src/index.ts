import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { AiRuntimeEffectLifecycleEvent } from "@cell/ai-runtime-control-contract"
import { makeUlid } from "@cell/symbiont-logic"
import { parseXnl, stringifyLineBlock, XNL } from "xnl-core"
import type { AttributeMap, DataElementNode, TextElementNode, XnlNode } from "xnl-core"

export * from "./AttachmentAssetStore"

export type AiRuntimeControlFileStorePaths = {
  rootDir: string
  headsDir: string
  cohortsDir: string
  effectsFile: string
}

export type RuntimeControlHeadFile = {
  headId: string
  sequence: number
  value: unknown
  updatedAt: string
}

export const RUNTIME_CONTROL_JOURNAL_HEAD_KINDS = [
  "ingress_log",
  "diagnostics_log",
  "effect_evidence",
] as const

export type RuntimeControlJournalHeadKind = (typeof RUNTIME_CONTROL_JOURNAL_HEAD_KINDS)[number]

export type RuntimeControlJournalSegment = {
  name: string
  count: number
}

export type RuntimeControlJournalHead<
  Kind extends RuntimeControlJournalHeadKind = RuntimeControlJournalHeadKind,
> = {
  kind: Kind
  count: number
  lastTag: string | null
  lastObservedAt: number | null
  lastSequence: number | null
  segments: RuntimeControlJournalSegment[]
}

export type RuntimeControlCohortCommitFile = {
  cohortId: string
  marker: string
  headSequences: Record<string, number>
  effectEvidenceSequence?: number
  committedAt: string
}

export type RuntimeControlSessionUpgradeFile = {
  version: 1
  strategy: "irreversible_owned_checkpoint"
  checkpointCohortId: string
  checkpointMarker: string
  headSequences: Record<string, number>
  effectEvidenceSequence?: number
  previousCheckpointMarker?: string | null
  upgradedAt: string
}

export type RealSessionDurableHeadState = {
  headId: string
  kind: string
  committedSequence: number
  value?: unknown
}

export type RuntimeControlReplayEvent = {
  tag: string
  metadata: Record<string, unknown>
  body: unknown[]
}

export type XnlTextRecordBodyItem = {
  kind: "text"
  tag: string
  text: string
  metadata?: Record<string, unknown>
}

export type XnlDataRecordBodyItem = {
  kind: "data"
  tag: string
  metadata?: Record<string, unknown>
  attributes?: Record<string, unknown>
  body?: XnlRecordBodyItem[]
  extend?: XnlRecordExtendChildren
}

export type XnlNodeRecordBodyItem = {
  kind: "node"
  node: DataElementNode | TextElementNode
}

export type XnlRecordBodyItem = XnlTextRecordBodyItem | XnlDataRecordBodyItem | XnlNodeRecordBodyItem
type XnlElementNode = DataElementNode | TextElementNode
export type XnlAppendDataRecordBody = XnlRecordBodyItem[]

export type XnlRecordExtendChildren = {
  order: string[]
  children: Record<string, XnlRecordBodyItem>
}

export type XnlAppendDataRecordInput = {
  filePath: string
  tag: string
  kind?: "data"
  metadata?: Record<string, unknown>
  attributes?: Record<string, unknown>
  body?: XnlRecordBodyItem[]
  extend?: XnlRecordExtendChildren
}

export type XnlAppendTextRecordInput = {
  filePath: string
  kind: "text"
  tag: string
  text: string
  metadata?: Record<string, unknown>
}

export type XnlAppendRecordInput = XnlAppendDataRecordInput | XnlAppendTextRecordInput

export type XnlStreamRecord = {
  kind: "data" | "text"
  tag: string
  metadata: Record<string, unknown>
  attributes: Record<string, unknown>
  body: XnlRecordBodyItem[]
  extend?: XnlRecordExtendChildren
  text?: string
  node: DataElementNode | TextElementNode
}

export type RuntimeControlEffectEvidenceEnvelope = {
  sequence: number
  event: AiRuntimeEffectLifecycleEvent
}

export type FileStoreAppendOnlyXnlMigrationResult = {
  migrated: {
    historyGenerations: number
    promptGenerations: number
    runtimeControlEffects: number
  }
  quarantinedPaths: string[]
}

export type FileStoreLegacyAppendOnlySessionFilesStatus = {
  hasLegacyAppendOnlyFiles: boolean
  paths: string[]
}

const effectEvidenceAppendQueues = new Map<string, Promise<unknown>>()
const xnlAppendQueues = new Map<string, Promise<unknown>>()
const LEGACY_JOURNAL_TAIL_WINDOW_BYTES = 16 * 1024 * 1024
const OBSERVATION_JOURNAL_SEGMENT_BYTES = 64 * 1024 * 1024

const LEGACY_JOURNAL_TAGS: Record<RuntimeControlJournalHeadKind, readonly string[]> = {
  ingress_log: [
    "IngressEvent",
    "ThinkDelta",
    "ContentDelta",
    "ToolDelta",
    "ControlEvent",
    "IngressDataEvent",
  ],
  diagnostics_log: ["DiagnosticEvent"],
  effect_evidence: ["RuntimeEffectEvent", "runtime-control-effect"],
}

function encodeSegment(value: string): string {
  return encodeURIComponent(String(value ?? "").trim() || "unknown")
}

function marker(): string {
  return makeUlid()
}

function toXnlAttributeMap(value?: Record<string, unknown>): AttributeMap {
  return (value ?? {}) as AttributeMap
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined))
}

function createXnlTextElement(item: XnlTextRecordBodyItem): TextElementNode {
  return {
    kind: "TextElement",
    tag: item.tag,
    metadata: toXnlAttributeMap(item.metadata),
    textMarker: marker(),
    text: item.text,
  }
}

function xnlNodeToBodyItem(value: any): XnlRecordBodyItem {
  if (value && typeof value === "object" && value.kind === "TextElement") {
    return {
      kind: "text",
      tag: String(value.tag ?? ""),
      text: String(value.text ?? ""),
      metadata: Object.fromEntries(
        Object.entries(value.metadata ?? {}).map(([key, child]) => [key, xnlMetadataValue(child)]),
      ),
    }
  }
  if (value && typeof value === "object" && value.kind === "DataElement") {
    const decodedAttributes = decodeXnlDataAttributes(value)
    return {
      kind: "data",
      tag: String(value.tag ?? ""),
      metadata: Object.fromEntries(
        Object.entries(value.metadata ?? {}).map(([key, child]) => [key, xnlMetadataValue(child)]),
      ),
      attributes: decodedAttributes,
      body: (Array.isArray(value.body) ? value.body : []).map((child: any) => xnlNodeToBodyItem(child)),
      extend: xnlExtendToRecordChildren(value.extend),
    }
  }
  return {
    kind: "node",
    node: value,
  }
}

function xnlTopLevelNodeToRecord(node: DataElementNode | TextElementNode): XnlStreamRecord {
  const metadata = Object.fromEntries(
    Object.entries(node.metadata ?? {}).map(([key, value]) => [key, xnlMetadataValue(value)]),
  )
  if (node.kind === "TextElement") {
    return {
      kind: "text",
      tag: String(node.tag ?? ""),
      metadata,
      attributes: {},
      body: [],
      text: String(node.text ?? ""),
      node,
    }
  }
  return {
    kind: "data",
    tag: String(node.tag ?? ""),
    metadata,
    attributes: Object.fromEntries(
      Object.entries(node.attributes ?? {}).map(([key, value]) => [key, xnlMetadataValue(value)]),
    ),
    body: (Array.isArray(node.body) ? node.body : []).map((child: any) => xnlNodeToBodyItem(child)),
    extend: xnlExtendToRecordChildren(node.extend),
    node,
  }
}

function xnlExtendToRecordChildren(extend: any): XnlRecordExtendChildren | undefined {
  if (!extend || !Array.isArray(extend.order) || !extend.children || typeof extend.children !== "object") {
    return undefined
  }
  const children: Record<string, XnlRecordBodyItem> = {}
  const order = extend.order.map((tag: unknown) => String(tag))
  for (const tag of order) {
    if (extend.children[tag]) {
      children[tag] = xnlNodeToBodyItem(extend.children[tag])
    }
  }
  return { order, children }
}

export function getXnlUniqueChild(
  record: { extend?: XnlRecordExtendChildren } | undefined,
  tag: string,
): XnlRecordBodyItem | undefined {
  return record?.extend?.children?.[tag]
}

export function getXnlDataUniqueChild(
  record: { extend?: XnlRecordExtendChildren } | undefined,
  tag: string,
): XnlDataRecordBodyItem | undefined {
  const child = getXnlUniqueChild(record, tag)
  return child?.kind === "data" ? child : undefined
}

export function getXnlTextUniqueChild(
  record: { extend?: XnlRecordExtendChildren } | undefined,
  tag: string,
): XnlTextRecordBodyItem | undefined {
  const child = getXnlUniqueChild(record, tag)
  return child?.kind === "text" ? child : undefined
}

function assertXnlAppendStreamHasNoRootWrapper(doc: any, tag?: string): void {
  if (!tag) return
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : []
  const dataNodes = nodes.filter((node: any) => node?.kind === "DataElement")
  if (dataNodes.length !== 1) return
  const [node] = dataNodes
  const body = Array.isArray(node?.body) ? node.body : []
  if (tag && node?.tag === tag) return
  const childDataElements = body.filter((child: any) => child?.kind === "DataElement")
  const hasRequestedChildren = tag
    ? childDataElements.some((child: any) => child?.tag === tag)
    : childDataElements.length > 0
  if (hasRequestedChildren) {
    throw new Error("invalid_xnl_append_stream:root_wrapper")
  }
}

function observationJournalHeadTarget(filePath: string): {
  sessionDir: string
  kind: "ingress_log" | "diagnostics_log"
  observedAtKey: "observedAt" | "emittedAt"
} | null {
  const logsDir = path.dirname(filePath)
  if (path.basename(logsDir) !== "logs") return null
  const fileName = path.basename(filePath)
  if (fileName === "ingress.xnl") {
    return {
      sessionDir: path.dirname(logsDir),
      kind: "ingress_log",
      observedAtKey: "observedAt",
    }
  }
  if (fileName === "diagnostics.xnl") {
    return {
      sessionDir: path.dirname(logsDir),
      kind: "diagnostics_log",
      observedAtKey: "emittedAt",
    }
  }
  return null
}

function journalSequence(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function journalObservedAt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function observationJournalSegmentCount(
  head: RuntimeControlJournalHead<"ingress_log" | "diagnostics_log">,
  name: string,
): number | null {
  return head.segments.find((segment) => segment.name === name)?.count ?? null
}

async function observationJournalHasRotatedSegments(filePath: string): Promise<boolean> {
  for (const suffix of [".1", ".2"]) {
    try {
      await stat(`${filePath}${suffix}`)
      return true
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "ENOENT") throw error
    }
  }
  return false
}

async function advanceObservationJournalSegments(
  head: RuntimeControlJournalHead<"ingress_log" | "diagnostics_log">,
  filePath: string,
): Promise<RuntimeControlJournalSegment[]> {
  const activeName = path.basename(filePath)
  let activeCount = observationJournalSegmentCount(head, activeName)
  if (activeCount === null
    && head.segments.length === 0
    && !(await observationJournalHasRotatedSegments(filePath))) {
    activeCount = head.count
  }
  const segments = [`${activeName}.2`, `${activeName}.1`]
    .map((name) => {
      const count = observationJournalSegmentCount(head, name)
      return count === null ? null : { name, count }
    })
    .filter((segment): segment is RuntimeControlJournalSegment => segment !== null)
  return activeCount === null
    ? segments
    : [...segments, { name: activeName, count: activeCount + 1 }]
}

async function renameIfPresent(source: string, destination: string): Promise<boolean> {
  try {
    await rename(source, destination)
    return true
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return false
    throw error
  }
}

async function removeOlderObservationJournalSegments(filePath: string): Promise<void> {
  const directory = path.dirname(filePath)
  const prefix = `${path.basename(filePath)}.`
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return
    throw error
  }
  await Promise.all(entries.map(async (name) => {
    if (!name.startsWith(prefix)) return
    const suffix = name.slice(prefix.length)
    if (!/^\d+$/.test(suffix) || Number(suffix) <= 2) return
    await rm(path.join(directory, name), { force: true })
  }))
}

async function rotateObservationJournalIfNeeded<Kind extends "ingress_log" | "diagnostics_log">(params: {
  filePath: string
  sessionDir: string
  head: RuntimeControlJournalHead<Kind> | null
}): Promise<RuntimeControlJournalHead<Kind> | null> {
  let activeSize: number
  try {
    activeSize = (await stat(params.filePath)).size
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return params.head
    throw error
  }
  if (activeSize < OBSERVATION_JOURNAL_SEGMENT_BYTES) return params.head

  const activeName = path.basename(params.filePath)
  const firstRotatedPath = `${params.filePath}.1`
  const secondRotatedPath = `${params.filePath}.2`
  const hadSecondRotatedSegment = await stat(secondRotatedPath)
    .then(() => true)
    .catch((error) => {
      if ((error as { code?: unknown })?.code === "ENOENT") return false
      throw error
    })
  await rm(secondRotatedPath, { force: true })
  const retainedFirstSegment = await renameIfPresent(firstRotatedPath, secondRotatedPath)
  await rename(params.filePath, firstRotatedPath)
  await removeOlderObservationJournalSegments(params.filePath)

  if (!params.head) return null
  let currentCount = observationJournalSegmentCount(params.head, activeName)
  if (currentCount === null
    && params.head.segments.length === 0
    && !retainedFirstSegment
    && !hadSecondRotatedSegment) {
    currentCount = params.head.count
  }
  const previousFirstCount = observationJournalSegmentCount(params.head, `${activeName}.1`)
  const segments: RuntimeControlJournalSegment[] = []
  if (retainedFirstSegment && previousFirstCount !== null) {
    segments.push({ name: `${activeName}.2`, count: previousFirstCount })
  }
  if (currentCount !== null) {
    segments.push({ name: `${activeName}.1`, count: currentCount })
  }
  segments.push({ name: activeName, count: 0 })
  return await writeRuntimeControlJournalHead({
    sessionDir: params.sessionDir,
    head: { ...params.head, segments },
  })
}

async function advanceObservationJournalHead<Kind extends "ingress_log" | "diagnostics_log">(
  input: XnlAppendRecordInput,
  target: NonNullable<ReturnType<typeof observationJournalHeadTarget>> & { kind: Kind },
  head: RuntimeControlJournalHead<Kind> | null,
): Promise<void> {
  if (!head) return
  await writeRuntimeControlJournalHead({
    sessionDir: target.sessionDir,
    head: {
      ...head,
      count: head.count + 1,
      lastTag: input.tag,
      lastObservedAt: journalObservedAt(input.metadata?.[target.observedAtKey]),
      lastSequence: journalSequence(input.metadata?.sequence),
      segments: await advanceObservationJournalSegments(head, input.filePath),
    },
  })
}

export async function appendXnlRecord(input: XnlAppendRecordInput): Promise<void> {
  const previous = xnlAppendQueues.get(input.filePath) ?? Promise.resolve()
  const write = previous
    .catch(() => {})
    .then(async () => {
      const target = observationJournalHeadTarget(input.filePath)
      let head: RuntimeControlJournalHead<"ingress_log" | "diagnostics_log"> | null = null
      if (target) {
        head = await initializeLegacyRuntimeControlJournalHead({
          sessionDir: target.sessionDir,
          kind: target.kind,
          filePath: input.filePath,
        })
        head = await rotateObservationJournalIfNeeded({
          filePath: input.filePath,
          sessionDir: target.sessionDir,
          head,
        })
      }
      await mkdir(path.dirname(input.filePath), { recursive: true })
      await appendFile(input.filePath, `${stringifyLineBlock(createXnlRecordNode(input))}\n`, "utf8")
      if (target) {
        await advanceObservationJournalHead(input, target, head)
      }
    })
  xnlAppendQueues.set(input.filePath, write)
  try {
    await write
  } finally {
    if (xnlAppendQueues.get(input.filePath) === write) {
      xnlAppendQueues.delete(input.filePath)
    }
  }
}

export function appendXnlRecordSync(input: XnlAppendRecordInput): void {
  mkdirSync(path.dirname(input.filePath), { recursive: true })
  appendFileSync(input.filePath, `${stringifyLineBlock(createXnlRecordNode(input))}\n`, "utf8")
}

export async function readXnlRecords(input: {
  filePath: string
  tag?: string
}): Promise<XnlStreamRecord[]> {
  let raw = ""
  try {
    raw = await readFile(input.filePath, "utf8")
  } catch {
    return []
  }
  const doc = parseXnl(raw)
  assertXnlAppendStreamHasNoRootWrapper(doc, input.tag)
  return (Array.isArray(doc.nodes) ? doc.nodes : [])
    .filter((node: any) => node?.kind === "DataElement" || node?.kind === "TextElement")
    .filter((node: any) => !input.tag || node?.tag === input.tag)
    .map((node: any) => xnlTopLevelNodeToRecord(node))
}

async function appendRuntimeControlEffectEvidenceEnvelope(params: {
  sessionDir: string
  sequence: number
  event: AiRuntimeEffectLifecycleEvent
}): Promise<void> {
  const paths = getAiRuntimeControlFileStorePaths(params.sessionDir)
  await appendXnlRecord({
    filePath: paths.effectsFile,
    tag: "RuntimeEffectEvent",
    metadata: runtimeEffectEventMetadata(params.sequence, params.event),
    extend: runtimeEffectEventExtend(params.event),
  })
  const head = await readRuntimeControlJournalHead({
    sessionDir: params.sessionDir,
    kind: "effect_evidence",
  })
  await writeRuntimeControlJournalHead({
    sessionDir: params.sessionDir,
    head: {
      ...head,
      count: head.count + 1,
      lastTag: "RuntimeEffectEvent",
      lastObservedAt: null,
      lastSequence: params.sequence,
    },
  })
}

function runtimeEffectEventMetadata(
  sequence: number,
  event: AiRuntimeEffectLifecycleEvent,
): Record<string, unknown> {
  return omitUndefined({
    version: 1,
    sequence,
    kind: event.kind,
    effectKind: event.effectKind,
    effectId: event.effectId,
    handlerKey: event.handlerKey,
    idempotencyKey: "idempotencyKey" in event ? event.idempotencyKey : undefined,
    sourceCommandId: "sourceCommandId" in event ? event.sourceCommandId : undefined,
    waitReason: "waitReason" in event ? event.waitReason : undefined,
    resultId: "resultId" in event ? event.resultId : undefined,
    retryable: "retryable" in event ? event.retryable : undefined,
  })
}

function runtimeEffectEventExtend(event: AiRuntimeEffectLifecycleEvent): XnlRecordExtendChildren {
  const child = runtimeEffectEventChild(event)
  return {
    order: [child.tag],
    children: {
      [child.tag]: child,
    },
  }
}

function runtimeEffectEventChild(event: AiRuntimeEffectLifecycleEvent): XnlDataRecordBodyItem {
  if (event.kind === "request") {
    return {
      kind: "data",
      tag: "Request",
      attributes: runtimeEffectSubjectAttributes(event.payload),
    }
  }
  if (event.kind === "waiting") {
    return {
      kind: "data",
      tag: "Wait",
      attributes: runtimeEffectSubjectAttributes(event.payload),
    }
  }
  if (event.kind === "result") {
    return {
      kind: "data",
      tag: "Result",
      attributes: runtimeEffectSubjectAttributes(event.payload),
    }
  }
  return {
    kind: "data",
    tag: "Error",
    attributes: {
      message: event.error,
      retryable: event.retryable,
    },
  }
}

function runtimeEffectSubjectAttributes(payload: unknown): Record<string, unknown> | undefined {
  if (payload === undefined) return undefined
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>
  }
  return { value: payload }
}

function createXnlRecordNode(input: XnlAppendRecordInput): DataElementNode | TextElementNode {
  if (input.kind === "text") {
    return createXnlTextElement(input)
  }
  return {
    kind: "DataElement",
    tag: input.tag,
    metadata: toXnlAttributeMap(input.metadata),
    attributes: input.attributes !== undefined ? toXnlAttributeMap(input.attributes) : undefined,
    body: (input.body ?? []).map((item) => createXnlBodyNode(item)),
    extend: input.extend ? createXnlExtend(input.extend) : undefined,
  }
}

function createXnlBodyNode(item: XnlRecordBodyItem): XnlNode {
  if (item.kind === "text") return createXnlTextElement(item)
  if (item.kind === "node") return item.node
  return {
    kind: "DataElement",
    tag: item.tag,
    metadata: toXnlAttributeMap(item.metadata),
    attributes: item.attributes !== undefined ? toXnlAttributeMap(item.attributes) : undefined,
    body: item.body ? item.body.map((child) => createXnlBodyNode(child)) : undefined,
    extend: item.extend ? createXnlExtend(item.extend) : undefined,
  } satisfies DataElementNode
}

function createXnlExtend(extend: XnlRecordExtendChildren): DataElementNode["extend"] {
  const children: Record<string, XnlElementNode> = {}
  for (const tag of extend.order) {
    const child = extend.children[tag]
    if (child) children[tag] = createXnlBodyElementNode(child)
  }
  return {
    order: extend.order,
    children,
  }
}

function createXnlBodyElementNode(item: XnlRecordBodyItem): XnlElementNode {
  const node = createXnlBodyNode(item) as any
  if (node && typeof node === "object" && (node.kind === "DataElement" || node.kind === "TextElement")) {
    return node as XnlElementNode
  }
  return {
    kind: "DataElement",
    tag: "Value",
    metadata: {},
    body: [encodeStructuredXnlValue(node)],
  } satisfies DataElementNode
}

function encodeStructuredXnlValue(value: unknown): XnlNode {
  if (value === null || value === undefined) {
    return { kind: "DataElement", tag: "Null", metadata: {} } satisfies DataElementNode
  }
  if (typeof value === "string") {
    return {
      kind: "TextElement",
      tag: "String",
      metadata: {},
      textMarker: marker(),
      text: value,
    } satisfies TextElementNode
  }
  if (typeof value === "number") {
    return { kind: "DataElement", tag: "Number", metadata: { value } as AttributeMap } satisfies DataElementNode
  }
  if (typeof value === "boolean") {
    return { kind: "DataElement", tag: "Boolean", metadata: { value } as AttributeMap } satisfies DataElementNode
  }
  if (Array.isArray(value)) {
    return {
      kind: "DataElement",
      tag: "Array",
      metadata: {},
      body: value.map((item, index) => ({
        kind: "DataElement",
        tag: "Item",
        metadata: { index } as AttributeMap,
        body: [encodeStructuredXnlValue(item)],
      })),
    } satisfies DataElementNode
  }
  if (typeof value === "object") {
    return {
      kind: "DataElement",
      tag: "Object",
      metadata: {},
      body: Object.entries(value as Record<string, unknown>).map(([name, child]) => ({
        kind: "DataElement",
        tag: "Field",
        metadata: { name } as AttributeMap,
        body: [encodeStructuredXnlValue(child)],
      })),
    } satisfies DataElementNode
  }
  return {
    kind: "TextElement",
    tag: "String",
    metadata: {},
    textMarker: marker(),
    text: String(value),
  } satisfies TextElementNode
}

function decodeXnlDataAttributes(node: DataElementNode): Record<string, unknown> {
  const attributesNode = (node.body ?? [])
    .find((child: any) => child?.kind === "DataElement" && child?.tag === "Attributes") as DataElementNode | undefined
  if (!attributesNode) {
    return Object.fromEntries(
      Object.entries(node.attributes ?? {}).map(([key, child]) => [key, xnlMetadataValue(child)]),
    )
  }
  const valueNode = attributesNode.body?.[0]
  const decoded = decodeStructuredXnlValue(valueNode)
  return decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? decoded as Record<string, unknown>
    : {}
}

function decodeStructuredXnlValue(node: any): unknown {
  if (!node || typeof node !== "object") return xnlMetadataValue(node)
  if (node.kind === "TextElement") return String(node.text ?? "")
  if (node.kind !== "DataElement") return xnlMetadataValue(node)
  switch (node.tag) {
    case "Null":
      return null
    case "Number":
      return Number(node.metadata?.value ?? 0)
    case "Boolean":
      return Boolean(node.metadata?.value)
    case "String":
      return String(node.body?.[0]?.text ?? "")
    case "Array":
      return (node.body ?? [])
        .filter((child: any) => child?.kind === "DataElement" && child?.tag === "Item")
        .sort((left: any, right: any) => Number(left.metadata?.index ?? 0) - Number(right.metadata?.index ?? 0))
        .map((child: any) => decodeStructuredXnlValue(child.body?.[0]))
    case "Object":
      return Object.fromEntries(
        (node.body ?? [])
          .filter((child: any) => child?.kind === "DataElement" && child?.tag === "Field")
          .map((child: any) => [String(child.metadata?.name ?? ""), decodeStructuredXnlValue(child.body?.[0])]),
      )
    default:
      return node
  }
}

export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

export async function readJsonBestEffort<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8")
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function getAiRuntimeControlFileStorePaths(sessionDir: string): AiRuntimeControlFileStorePaths {
  const rootDir = path.join(sessionDir, "runtime-control")
  return {
    rootDir,
    headsDir: path.join(rootDir, "heads"),
    cohortsDir: path.join(rootDir, "cohorts"),
    effectsFile: path.join(rootDir, "effects.xnl"),
  }
}

export function getRuntimeControlHeadFilePath(sessionDir: string, headId: string): string {
  return path.join(getAiRuntimeControlFileStorePaths(sessionDir).headsDir, `${encodeSegment(headId)}.json`)
}

export function createEmptyRuntimeControlJournalHead<Kind extends RuntimeControlJournalHeadKind>(
  kind: Kind,
): RuntimeControlJournalHead<Kind> {
  return {
    kind,
    count: 0,
    lastTag: null,
    lastObservedAt: null,
    lastSequence: null,
    segments: [],
  }
}

function normalizeRuntimeControlJournalHead<Kind extends RuntimeControlJournalHeadKind>(
  value: unknown,
  kind: Kind,
): RuntimeControlJournalHead<Kind> | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Record<string, unknown>
  let source: Record<string, unknown>
  if (candidate.kind === kind) {
    source = candidate
  } else if (candidate.headId === kind && candidate.value && typeof candidate.value === "object") {
    const legacyValue = candidate.value as Record<string, unknown>
    source = {
      ...legacyValue,
      count: legacyValue.count ?? legacyValue.eventCount ?? candidate.sequence,
      lastObservedAt: legacyValue.lastObservedAt ?? legacyValue.lastEmittedAt,
      lastSequence: legacyValue.lastSequence ?? (kind === "effect_evidence" ? candidate.sequence : null),
    }
  } else {
    return null
  }

  const lastTag = source.lastTag ?? null
  const lastObservedAt = source.lastObservedAt ?? null
  const lastSequence = source.lastSequence ?? null
  const segmentValues = source.segments ?? []
  if (!Number.isSafeInteger(source.count) || Number(source.count) < 0) return null
  if (lastTag !== null && typeof lastTag !== "string") return null
  if (lastObservedAt !== null
    && (typeof lastObservedAt !== "number" || !Number.isFinite(lastObservedAt))) return null
  if (lastSequence !== null
    && (!Number.isSafeInteger(lastSequence) || Number(lastSequence) < 0)) return null
  if (!Array.isArray(segmentValues)) return null

  const segments: RuntimeControlJournalSegment[] = []
  for (const segment of segmentValues) {
    if (!segment || typeof segment !== "object") return null
    const entry = segment as Record<string, unknown>
    if (typeof entry.name !== "string" || entry.name.length === 0) return null
    if (!Number.isSafeInteger(entry.count) || Number(entry.count) < 0) return null
    segments.push({ name: entry.name, count: Number(entry.count) })
  }

  return {
    kind,
    count: Number(source.count),
    lastTag: lastTag as string | null,
    lastObservedAt: lastObservedAt as number | null,
    lastSequence: lastSequence as number | null,
    segments,
  }
}

async function readPersistedRuntimeControlJournalHead<Kind extends RuntimeControlJournalHeadKind>(params: {
  sessionDir: string
  kind: Kind
}): Promise<RuntimeControlJournalHead<Kind> | null> {
  const value = await readJsonBestEffort<unknown>(
    getRuntimeControlHeadFilePath(params.sessionDir, params.kind),
    null,
  )
  return normalizeRuntimeControlJournalHead(value, params.kind)
}

export async function writeRuntimeControlJournalHead<Kind extends RuntimeControlJournalHeadKind>(params: {
  sessionDir: string
  head: RuntimeControlJournalHead<Kind>
}): Promise<RuntimeControlJournalHead<Kind>> {
  const head = normalizeRuntimeControlJournalHead(params.head, params.head.kind)
  if (!head) {
    throw new Error(`invalid_runtime_control_journal_head:${params.head.kind}`)
  }
  await writeJsonAtomically(getRuntimeControlHeadFilePath(params.sessionDir, head.kind), head)
  return head
}

export async function readRuntimeControlJournalHead<Kind extends RuntimeControlJournalHeadKind>(params: {
  sessionDir: string
  kind: Kind
}): Promise<RuntimeControlJournalHead<Kind>> {
  return await readPersistedRuntimeControlJournalHead(params)
    ?? createEmptyRuntimeControlJournalHead(params.kind)
}

type BoundedJournalTail = {
  exists: boolean
  fileSize: number
  startOffset: number
  bytes: Buffer
}

async function readBoundedJournalTail(filePath: string): Promise<BoundedJournalTail | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(filePath, "r")
    const stats = await handle.stat()
    const fileSize = stats.size
    const length = Math.min(fileSize, LEGACY_JOURNAL_TAIL_WINDOW_BYTES)
    const startOffset = fileSize - length
    const bytes = Buffer.allocUnsafe(length)
    let bytesRead = 0
    while (bytesRead < length) {
      const result = await handle.read(bytes, bytesRead, length - bytesRead, startOffset + bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    return {
      exists: true,
      fileSize,
      startOffset,
      bytes: bytes.subarray(0, bytesRead),
    }
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return { exists: false, fileSize: 0, startOffset: 0, bytes: Buffer.alloc(0) }
    }
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

function isXnlTagDelimiter(byte: number | undefined): boolean {
  return byte === undefined
    || byte === 0x09
    || byte === 0x0a
    || byte === 0x0d
    || byte === 0x20
    || byte === 0x28
    || byte === 0x3e
    || byte === 0x3f
    || byte === 0x5b
    || byte === 0x7b
}

function xnlDocumentContentStart(bytes: Buffer): number {
  let offset = bytes.length >= 3
    && bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf
    ? 3
    : 0
  while (offset < bytes.length) {
    const byte = bytes[offset]
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) break
    offset += 1
  }
  return offset
}

function legacyJournalCandidateOffsets(
  tail: BoundedJournalTail,
  allowedTags: readonly string[],
): number[] {
  const offsets: number[] = []
  const documentStart = tail.startOffset === 0 ? xnlDocumentContentStart(tail.bytes) : -1
  for (let offset = 0; offset < tail.bytes.length; offset += 1) {
    if (tail.bytes[offset] !== 0x3c) continue
    const isRangeStart = offset === 0
    const isLineStart = offset > 0 && tail.bytes[offset - 1] === 0x0a
    const isDocumentStart = offset === documentStart
    if (!isRangeStart && !isLineStart && !isDocumentStart) continue
    for (const tag of allowedTags) {
      const encodedTag = Buffer.from(tag, "ascii")
      const tagStart = offset + 1
      const tagEnd = tagStart + encodedTag.length
      if (tagEnd > tail.bytes.length) continue
      if (!tail.bytes.subarray(tagStart, tagEnd).equals(encodedTag)) continue
      if (!isXnlTagDelimiter(tail.bytes[tagEnd])) continue
      offsets.push(offset)
      break
    }
    if (allowedTags.length === 0) {
      const tagStart = offset + 1
      let tagEnd = tagStart
      while (tagEnd < tail.bytes.length && !isXnlTagDelimiter(tail.bytes[tagEnd])) tagEnd += 1
      if (tagEnd > tagStart && isXnlTagDelimiter(tail.bytes[tagEnd])) offsets.push(offset)
    }
  }
  return offsets
}

function parseLegacyJournalTail(
  tail: BoundedJournalTail,
  allowedTags: readonly string[],
): { records: XnlStreamRecord[]; coversWholeDocument: boolean } | null {
  if (tail.bytes.length === 0) return null
  const allowed = new Set(allowedTags)
  const documentStart = tail.startOffset === 0 ? xnlDocumentContentStart(tail.bytes) : -1
  for (const offset of legacyJournalCandidateOffsets(tail, allowedTags)) {
    try {
      const doc = parseXnl(tail.bytes.subarray(offset).toString("utf8"))
      const nodes = Array.isArray(doc.nodes) ? doc.nodes : []
      if (nodes.length === 0 || !nodes.every((node: any) => (
        (node?.kind === "DataElement" || node?.kind === "TextElement") && allowed.has(node.tag)
      ))) continue
      return {
        records: nodes.map((node: any) => xnlTopLevelNodeToRecord(node)),
        coversWholeDocument: offset === documentStart,
      }
    } catch {
      // A line beginning with '<' inside a text payload is not a parseable top-level suffix.
    }
  }
  return null
}

export type XnlEdgeRecordsProjection = {
  readonly exists: boolean
  readonly fileSize: number
  readonly observedBytes: number
  readonly head: ReadonlyArray<XnlStreamRecord>
  readonly tail: ReadonlyArray<XnlStreamRecord>
}

const DEFAULT_XNL_EDGE_WINDOW_BYTES = 64 * 1024

function parseCompleteXnlRecordsFromWindow(
  window: BoundedJournalTail,
  allowedTags: readonly string[],
): XnlStreamRecord[] {
  return parseCompleteXnlRecordEntriesFromWindow(window, allowedTags).map((entry) => entry.record)
}

type ParsedXnlRecordEntry = {
  record: XnlStreamRecord
  startOffset: number
  endOffset: number
}

function parseCompleteXnlRecordEntriesFromWindow(
  window: BoundedJournalTail,
  allowedTags: readonly string[],
  includeAllTags = false,
): ParsedXnlRecordEntry[] {
  const allowed = new Set(allowedTags)
  // Boundaries must include every top-level record, not only requested tags.
  // Otherwise a mixed stream A -> B -> A makes the slice for A contain B too,
  // and both valid A records disappear from pagination.
  const offsets = legacyJournalCandidateOffsets(window, [])
  const records: ParsedXnlRecordEntry[] = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = offsets[index + 1] ?? window.bytes.length
    try {
      const doc = parseXnl(window.bytes.subarray(start, end).toString("utf8"))
      const nodes = Array.isArray(doc.nodes) ? doc.nodes : []
      if (nodes.length !== 1) continue
      const node = nodes[0] as any
      if ((node?.kind !== "DataElement" && node?.kind !== "TextElement")
        || (!includeAllTags && !allowed.has(node.tag))) continue
      records.push({
        record: xnlTopLevelNodeToRecord(node),
        startOffset: window.startOffset + start,
        endOffset: window.startOffset + end,
      })
    } catch {
      // A window may begin/end inside a record. Only parser-proven complete
      // top-level records are returned to callers.
    }
  }
  return records
}

export type XnlRecordPageEntry = {
  readonly record: XnlStreamRecord
  readonly startOffset: number
  readonly endOffset: number
}

export type XnlRecordPageProjection = {
  readonly exists: boolean
  readonly fileSize: number
  readonly observedBytes: number
  readonly records: ReadonlyArray<XnlRecordPageEntry>
  readonly previousOffset: number | null
  readonly hasPreviousPage: boolean
  readonly oversizedRecord: boolean
}

const DEFAULT_XNL_PAGE_LIMIT = 40
const DEFAULT_XNL_PAGE_MAX_OBSERVED_BYTES = 4 * 1024 * 1024

/**
 * Read one reverse page from an append-only XNL stream without materializing
 * the whole document. `beforeOffset` is an adapter-private, parser-proven
 * record boundary returned by a previous call. Records are returned in source
 * order even though the file is scanned backwards.
 */
export async function readXnlRecordPage(input: {
  filePath: string
  tags: string | readonly string[]
  beforeOffset?: number | null
  limit?: number
  windowBytes?: number
  maxObservedBytes?: number
}): Promise<XnlRecordPageProjection> {
  const allowedTags = typeof input.tags === "string" ? [input.tags] : [...input.tags]
  const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_XNL_PAGE_LIMIT))
  const maxObservedBytes = Math.max(1, Math.floor(
    input.maxObservedBytes ?? DEFAULT_XNL_PAGE_MAX_OBSERVED_BYTES,
  ))
  const windowBytes = Math.min(
    maxObservedBytes,
    Math.max(1024, Math.floor(input.windowBytes ?? DEFAULT_XNL_EDGE_WINDOW_BYTES)),
  )
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(input.filePath, "r")
    const fileSize = (await handle.stat()).size
    let scanEnd = Math.min(fileSize, Math.max(0, Math.floor(input.beforeOffset ?? fileSize)))
    const newestFirst: ParsedXnlRecordEntry[] = []
    const seenOffsets = new Set<number>()
    let observedBytes = 0
    let oversizedRecord = false

    const readRange = async (startOffset: number, endOffset: number): Promise<BoundedJournalTail> => {
      const length = Math.max(0, endOffset - startOffset)
      const bytes = Buffer.allocUnsafe(length)
      let bytesRead = 0
      while (bytesRead < length) {
        const result = await handle!.read(bytes, bytesRead, length - bytesRead, startOffset + bytesRead)
        if (result.bytesRead === 0) break
        bytesRead += result.bytesRead
      }
      observedBytes += bytesRead
      return { exists: true, fileSize, startOffset, bytes: bytes.subarray(0, bytesRead) }
    }

    while (scanEnd > 0 && newestFirst.length < limit && observedBytes < maxObservedBytes) {
      let scanStart = scanEnd
      let accumulated = Buffer.alloc(0)
      let entries: ParsedXnlRecordEntry[] = []
      while (scanStart > 0 && observedBytes < maxObservedBytes) {
        const readLength = Math.min(windowBytes, scanStart, maxObservedBytes - observedBytes)
        const nextStart = scanStart - readLength
        const chunk = await readRange(nextStart, scanStart)
        accumulated = Buffer.concat([chunk.bytes, accumulated])
        scanStart = nextStart
        const window: BoundedJournalTail = {
          exists: true,
          fileSize,
          startOffset: scanStart,
          bytes: accumulated,
        }
        const boundaryEntries = parseCompleteXnlRecordEntriesFromWindow(window, allowedTags, true)
        entries = boundaryEntries.filter((entry) => allowedTags.includes(entry.record.tag))
        if (boundaryEntries.length > 0 || scanStart === 0) {
          if (entries.length === 0) {
            const oldestBoundaryStart = boundaryEntries[0]?.startOffset
            scanEnd = oldestBoundaryStart ?? scanStart
          }
          break
        }
      }

      if (entries.length === 0 && scanStart > 0 && observedBytes >= maxObservedBytes) {
        // Do not advance past an unparsed record. The caller must surface the
        // explicit budget condition instead of silently omitting history.
        oversizedRecord = true
        break
      }

      for (let index = entries.length - 1; index >= 0 && newestFirst.length < limit; index -= 1) {
        const entry = entries[index]
        if (seenOffsets.has(entry.startOffset)) continue
        seenOffsets.add(entry.startOffset)
        newestFirst.push(entry)
      }

      const oldestCompleteStart = entries[0]?.startOffset
      if (oldestCompleteStart !== undefined && oldestCompleteStart < scanEnd) {
        scanEnd = oldestCompleteStart
      } else if (entries.length > 0) {
        scanEnd = scanStart
      }
    }

    const records = newestFirst.reverse()
    const previousOffset = oversizedRecord ? null : (records[0]?.startOffset ?? (scanEnd > 0 ? scanEnd : null))
    return {
      exists: true,
      fileSize,
      observedBytes,
      records,
      previousOffset,
      hasPreviousPage: previousOffset !== null && previousOffset > 0,
      oversizedRecord,
    }
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return {
        exists: false,
        fileSize: 0,
        observedBytes: 0,
        records: [],
        previousOffset: null,
        hasPreviousPage: false,
        oversizedRecord: false,
      }
    }
    throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Read parser-valid records from fixed-size head/tail windows of an append-only
 * XNL stream. This is a projection helper: it never interprets truncated edge
 * bytes as records and never expands the window to the full source size.
 */
export async function readXnlEdgeRecords(input: {
  filePath: string
  tags: string | readonly string[]
  windowBytes?: number
}): Promise<XnlEdgeRecordsProjection> {
  const allowedTags = typeof input.tags === "string" ? [input.tags] : [...input.tags]
  const windowBytes = Math.max(1, Math.floor(input.windowBytes ?? DEFAULT_XNL_EDGE_WINDOW_BYTES))
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(input.filePath, "r")
    const fileSize = (await handle.stat()).size
    const headLength = Math.min(fileSize, windowBytes)
    const tailStart = Math.max(0, fileSize - windowBytes)
    const tailLength = fileSize - tailStart

    const readWindow = async (startOffset: number, length: number): Promise<BoundedJournalTail> => {
      const bytes = Buffer.allocUnsafe(length)
      let bytesRead = 0
      while (bytesRead < length) {
        const result = await handle!.read(bytes, bytesRead, length - bytesRead, startOffset + bytesRead)
        if (result.bytesRead === 0) break
        bytesRead += result.bytesRead
      }
      return {
        exists: true,
        fileSize,
        startOffset,
        bytes: bytes.subarray(0, bytesRead),
      }
    }

    const headWindow = await readWindow(0, headLength)
    const sameWindow = tailStart === 0
    const tailWindow = sameWindow ? headWindow : await readWindow(tailStart, tailLength)
    return {
      exists: true,
      fileSize,
      observedBytes: headWindow.bytes.length + (sameWindow ? 0 : tailWindow.bytes.length),
      head: parseCompleteXnlRecordsFromWindow(headWindow, allowedTags),
      tail: sameWindow
        ? parseCompleteXnlRecordsFromWindow(headWindow, allowedTags)
        : parseCompleteXnlRecordsFromWindow(tailWindow, allowedTags),
    }
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return { exists: false, fileSize: 0, observedBytes: 0, head: [], tail: [] }
    }
    throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

function legacyJournalRecordCount(
  records: XnlStreamRecord[],
  coversWholeDocument: boolean,
): number | null {
  if (coversWholeDocument) return records.length
  let prefixCount: number | null = null
  for (let index = 0; index < records.length; index += 1) {
    const sequence = journalSequence(records[index]?.metadata?.sequence)
    if (sequence === null || sequence === 0) continue
    const candidatePrefixCount = sequence - index - 1
    if (candidatePrefixCount < 0) return null
    if (prefixCount !== null && prefixCount !== candidatePrefixCount) return null
    prefixCount = candidatePrefixCount
  }
  if (prefixCount !== null) {
    const count = prefixCount + records.length
    return Number.isSafeInteger(count) ? count : null
  }
  return null
}

async function deriveLegacyRuntimeControlJournalHead<Kind extends RuntimeControlJournalHeadKind>(params: {
  kind: Kind
  filePath: string
}): Promise<RuntimeControlJournalHead<Kind> | null> {
  const tail = await readBoundedJournalTail(params.filePath)
  if (!tail) return null
  if (!tail.exists || tail.fileSize === 0) return createEmptyRuntimeControlJournalHead(params.kind)
  const parsed = parseLegacyJournalTail(tail, LEGACY_JOURNAL_TAGS[params.kind])
  if (!parsed) return null
  const count = legacyJournalRecordCount(parsed.records, parsed.coversWholeDocument)
  if (count === null) return null
  const last = parsed.records.at(-1)
  const observedAtKey = params.kind === "ingress_log" ? "observedAt" : "emittedAt"
  return {
    kind: params.kind,
    count,
    lastTag: last?.tag ?? null,
    lastObservedAt: params.kind === "effect_evidence"
      ? null
      : journalObservedAt(last?.metadata?.[observedAtKey]),
    lastSequence: journalSequence(last?.metadata?.sequence),
    segments: [],
  }
}

async function deriveLegacyRotatedObservationJournalHead<
  Kind extends "ingress_log" | "diagnostics_log",
>(params: {
  kind: Kind
  filePath: string
}): Promise<RuntimeControlJournalHead<Kind> | null | undefined> {
  const activeName = path.basename(params.filePath)
  const candidates = [
    { name: `${activeName}.2`, filePath: `${params.filePath}.2` },
    { name: `${activeName}.1`, filePath: `${params.filePath}.1` },
    { name: activeName, filePath: params.filePath },
  ]
  const tails = await Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    tail: await readBoundedJournalTail(candidate.filePath),
  })))
  if (!tails.slice(0, 2).some(({ tail }) => tail?.exists)) return undefined

  const segments: RuntimeControlJournalSegment[] = []
  let previousSequence: number | null = null
  let last: XnlStreamRecord | undefined
  for (const { name, tail } of tails) {
    if (!tail) return null
    if (!tail.exists) continue
    if (tail.fileSize === 0) {
      segments.push({ name, count: 0 })
      continue
    }
    const parsed = parseLegacyJournalTail(tail, LEGACY_JOURNAL_TAGS[params.kind])
    if (!parsed) return null
    const sequences = parsed.records.map((record) => journalSequence(record.metadata?.sequence))
    if (sequences.some((sequence) => sequence === null || sequence === 0)) return null
    for (let index = 1; index < sequences.length; index += 1) {
      if (sequences[index] !== Number(sequences[index - 1]) + 1) return null
    }
    const firstSequence = sequences[0] as number
    if (previousSequence !== null) {
      if (firstSequence <= previousSequence) return null
      if (parsed.coversWholeDocument && firstSequence !== previousSequence + 1) return null
    }
    previousSequence = sequences.at(-1) as number
    last = parsed.records.at(-1)
    if (parsed.coversWholeDocument) {
      segments.push({ name, count: parsed.records.length })
    }
  }
  if (!last || previousSequence === null) {
    return { ...createEmptyRuntimeControlJournalHead(params.kind), segments }
  }

  // A retained tail can prove the cumulative ordinal without proving that
  // segment's local count. Unknown local counts stay absent from `segments`.
  const observedAtKey = params.kind === "ingress_log" ? "observedAt" : "emittedAt"
  return {
    kind: params.kind,
    count: previousSequence,
    lastTag: last?.tag ?? null,
    lastObservedAt: journalObservedAt(last?.metadata?.[observedAtKey]),
    lastSequence: journalSequence(last?.metadata?.sequence),
    segments,
  }
}

async function initializeLegacyRuntimeControlJournalHead<Kind extends RuntimeControlJournalHeadKind>(params: {
  sessionDir: string
  kind: Kind
  filePath: string
}): Promise<RuntimeControlJournalHead<Kind> | null> {
  const persisted = await readPersistedRuntimeControlJournalHead(params)
  if (persisted) return persisted
  if (params.kind === "ingress_log" || params.kind === "diagnostics_log") {
    const rotated = await deriveLegacyRotatedObservationJournalHead({
      kind: params.kind,
      filePath: params.filePath,
    })
    if (rotated !== undefined) {
      if (!rotated) return null
      await writeRuntimeControlJournalHead({ sessionDir: params.sessionDir, head: rotated })
      return rotated as RuntimeControlJournalHead<Kind>
    }
  }
  const initialized = await deriveLegacyRuntimeControlJournalHead(params)
  if (!initialized) return null
  await writeRuntimeControlJournalHead({ sessionDir: params.sessionDir, head: initialized })
  return initialized
}

async function readOrInitializeObservationJournalHead<Kind extends "ingress_log" | "diagnostics_log">(params: {
  sessionDir: string
  kind: Kind
  filePath: string
}): Promise<RuntimeControlJournalHead<Kind>> {
  const persisted = await readPersistedRuntimeControlJournalHead(params)
  if (persisted) return persisted
  const previous = xnlAppendQueues.get(params.filePath) ?? Promise.resolve()
  const read = previous
    .catch(() => {})
    .then(async () => await initializeLegacyRuntimeControlJournalHead(params))
  xnlAppendQueues.set(params.filePath, read)
  try {
    return await read ?? createEmptyRuntimeControlJournalHead(params.kind)
  } finally {
    if (xnlAppendQueues.get(params.filePath) === read) {
      xnlAppendQueues.delete(params.filePath)
    }
  }
}

export function getRuntimeControlCohortCommitFilePath(sessionDir: string, cohortId: string): string {
  return path.join(getAiRuntimeControlFileStorePaths(sessionDir).cohortsDir, `${encodeSegment(cohortId)}.commit.json`)
}

export function getRuntimeControlSessionUpgradeFilePath(sessionDir: string): string {
  return path.join(getAiRuntimeControlFileStorePaths(sessionDir).rootDir, "upgrade.json")
}

export async function writeRuntimeControlHeadFile(params: {
  sessionDir: string
  headId: string
  sequence: number
  value: unknown
  now?: () => Date
}): Promise<RuntimeControlHeadFile> {
  const file: RuntimeControlHeadFile = {
    headId: params.headId,
    sequence: params.sequence,
    value: params.value,
    updatedAt: (params.now ?? (() => new Date()))().toISOString(),
  }
  await writeJsonAtomically(getRuntimeControlHeadFilePath(params.sessionDir, params.headId), file)
  return file
}

export async function readRuntimeControlHeadFile(params: {
  sessionDir: string
  headId: string
}): Promise<RuntimeControlHeadFile | null> {
  return await readJsonBestEffort<RuntimeControlHeadFile | null>(
    getRuntimeControlHeadFilePath(params.sessionDir, params.headId),
    null,
  )
}

export async function writeRuntimeControlCohortCommitFile(params: {
  sessionDir: string
  cohortId: string
  headSequences: Record<string, number>
  effectEvidenceSequence?: number
  now?: () => Date
}): Promise<RuntimeControlCohortCommitFile> {
  const marker = `${params.cohortId}:${Object.entries(params.headSequences)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([headId, sequence]) => `${headId}=${sequence}`)
    .join(",")}`
  const file: RuntimeControlCohortCommitFile = {
    cohortId: params.cohortId,
    marker,
    headSequences: params.headSequences,
    effectEvidenceSequence: params.effectEvidenceSequence,
    committedAt: (params.now ?? (() => new Date()))().toISOString(),
  }
  await writeJsonAtomically(getRuntimeControlCohortCommitFilePath(params.sessionDir, params.cohortId), file)
  return file
}

export async function readRuntimeControlCohortCommitFile(params: {
  sessionDir: string
  cohortId: string
}): Promise<RuntimeControlCohortCommitFile | null> {
  return await readJsonBestEffort<RuntimeControlCohortCommitFile | null>(
    getRuntimeControlCohortCommitFilePath(params.sessionDir, params.cohortId),
    null,
  )
}

export async function writeRuntimeControlSessionUpgradeFile(params: {
  sessionDir: string
  checkpointCohortId: string
  checkpointMarker: string
  headSequences: Record<string, number>
  effectEvidenceSequence?: number
  previousCheckpointMarker?: string | null
  now?: () => Date
}): Promise<RuntimeControlSessionUpgradeFile> {
  const file: RuntimeControlSessionUpgradeFile = {
    version: 1,
    strategy: "irreversible_owned_checkpoint",
    checkpointCohortId: params.checkpointCohortId,
    checkpointMarker: params.checkpointMarker,
    headSequences: params.headSequences,
    effectEvidenceSequence: params.effectEvidenceSequence,
    previousCheckpointMarker: params.previousCheckpointMarker ?? null,
    upgradedAt: (params.now ?? (() => new Date()))().toISOString(),
  }
  await writeJsonAtomically(getRuntimeControlSessionUpgradeFilePath(params.sessionDir), file)
  return file
}

export async function readRuntimeControlSessionUpgradeFile(params: {
  sessionDir: string
}): Promise<RuntimeControlSessionUpgradeFile | null> {
  return await readJsonBestEffort<RuntimeControlSessionUpgradeFile | null>(
    getRuntimeControlSessionUpgradeFilePath(params.sessionDir),
    null,
  )
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath)
    return true
  } catch {
    return false
  }
}

async function quarantineLegacyAppendOnlyPath(params: {
  sessionDir: string
  filePath: string
}): Promise<string | null> {
  if (!await fileExists(params.filePath)) return null
  const relative = path.relative(params.sessionDir, params.filePath)
  const target = path.join(params.sessionDir, "backup", "legacy-append-only", relative)
  await mkdir(path.dirname(target), { recursive: true })
  await rm(target, { recursive: true, force: true }).catch(() => {})
  await rename(params.filePath, target)
  return target
}

async function migrateLegacyJsonGenerationFiles(params: {
  sessionDir: string
  sourceDir: string
  targetFile: string
  recordTag: string
  bodyTag: string
  metadata: (value: any) => Record<string, unknown>
}): Promise<{ migrated: number; quarantinedPaths: string[] }> {
  const files = (await listFilesRecursive(params.sourceDir))
    .filter((filePath) => path.extname(filePath) === ".json")
  let migrated = 0
  const quarantinedPaths: string[] = []
  for (const filePath of files) {
    const value = await readJsonBestEffort<any>(filePath, null)
    if (value && typeof value === "object") {
      await appendXnlRecord({
        filePath: params.targetFile,
        tag: params.recordTag,
        metadata: params.metadata(value),
        body: [{ kind: "data", tag: params.bodyTag, attributes: value }],
      })
      migrated += 1
    }
    const quarantined = await quarantineLegacyAppendOnlyPath({
      sessionDir: params.sessionDir,
      filePath,
    })
    if (quarantined) quarantinedPaths.push(quarantined)
  }
  return { migrated, quarantinedPaths }
}

function legacyHistoryMessageBlocks(entry: any, recordId: string): XnlRecordBodyItem[] {
  const blocks: XnlRecordBodyItem[] = []
  const message = legacyHistoryEntryMessage(entry)
  const nextIndex = () => blocks.length
  const reasoning = message.reasoningContent ?? message.reasoning_content
  if (reasoning) {
    blocks.push({
      kind: "text",
      tag: "Think",
      metadata: { id: `${recordId}.b${nextIndex()}`, index: nextIndex() },
      text: String(reasoning),
    })
  }
  if (message.content && message.role !== "tool") {
    blocks.push({
      kind: "text",
      tag: "Content",
      metadata: { id: `${recordId}.b${nextIndex()}`, index: nextIndex() },
      text: String(message.content),
    })
  }
  for (const toolCall of message.toolCalls ?? message.tool_calls ?? []) {
    const name = toolCall.name ?? toolCall.function?.name
    const rawInput = toolCall.input ?? toolCall.function?.arguments
    let input = rawInput
    if (typeof rawInput === "string") {
      try {
        input = JSON.parse(rawInput)
      } catch {
        input = rawInput
      }
    }
    blocks.push({
      kind: "data",
      tag: "ToolCall",
      metadata: {
        id: `${recordId}.b${nextIndex()}`,
        index: nextIndex(),
        toolCallId: toolCall.id,
        name,
      },
      attributes: { input },
    })
  }
  const toolCallId = message.toolCallId ?? message.tool_call_id
  if (message.role === "tool" || toolCallId) {
    blocks.push({
      kind: "data",
      tag: "ToolResult",
      metadata: {
        id: `${recordId}.b${nextIndex()}`,
        index: nextIndex(),
        toolCallId,
      },
      attributes: {
        output: { kind: "text", text: message.content },
      },
    })
  }
  return blocks
}

function legacyHistoryEntryMessage(entry: any): Record<string, any> {
  return entry?.message && typeof entry.message === "object" && !Array.isArray(entry.message)
    ? entry.message
    : entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry
      : {}
}

function legacyHistoryEntryRecordId(generationId: string, entry: any, sequence: number): string {
  return typeof entry?.recordId === "string" && entry.recordId
    ? entry.recordId
    : `${generationId}::${sequence}`
}

async function migrateLegacyHistoryGenerationFiles(params: {
  sessionDir: string
  sourceDir: string
  targetFile: string
}): Promise<{ migrated: number; quarantinedPaths: string[] }> {
  const files = (await listFilesRecursive(params.sourceDir))
    .filter((filePath) => path.extname(filePath) === ".json")
  let migrated = 0
  const quarantinedPaths: string[] = []
  for (const filePath of files) {
    const generation = await readJsonBestEffort<any>(filePath, null)
    if (generation && typeof generation === "object") {
      for (const [sequence, entry] of (generation.messages ?? []).entries()) {
        const message = legacyHistoryEntryMessage(entry)
        const recordId = legacyHistoryEntryRecordId(String(generation.generationId ?? "history"), entry, sequence)
        const blocks = legacyHistoryMessageBlocks(entry, recordId)
        await appendXnlRecord({
          filePath: params.targetFile,
          tag: "HistoryMessage",
          metadata: {
            version: generation.version,
            id: recordId,
            sessionId: generation.sessionId,
            actorKey: entry.actorKey ?? generation.actorKey,
            actorId: entry.actorId ?? generation.actorId,
            role: message.role,
            name: message.name,
            startAt: message.startAt,
            endAt: message.endAt,
            committedAt: entry.committedAt,
            sequence,
            generationId: generation.generationId,
            parentGenerationId: generation.parentGenerationId ?? null,
            predecessorGenerationIds: generation.predecessorGenerationIds ?? [],
            createdReason: generation.createdReason,
            sealed: generation.sealed,
            messageCount: generation.messageCount,
            generationCreatedAt: generation.createdAt,
            generationUpdatedAt: generation.updatedAt,
            blockCount: blocks.length,
          },
          body: blocks,
        })
      }
      migrated += 1
    }
    const quarantined = await quarantineLegacyAppendOnlyPath({
      sessionDir: params.sessionDir,
      filePath,
    })
    if (quarantined) quarantinedPaths.push(quarantined)
  }
  return { migrated, quarantinedPaths }
}

function legacyPromptGenerationBody(generation: any): XnlRecordBodyItem[] {
  const body: XnlRecordBodyItem[] = [
    {
      kind: "data",
      tag: "Basis",
      metadata: { version: generation.basis?.version ?? generation.version },
      attributes: {
        historyGenerationIds: generation.basis?.basisHistoryGenerationIds ?? [],
        messageRecordIds: generation.basis?.basisMessageRecordIds ?? [],
      },
    },
  ]
  for (const [index, basisRef] of (generation.basis?.basisRefs ?? []).entries()) {
    body.push({
      kind: "data",
      tag: "BasisRef",
      metadata: { index, kind: basisRef.refKind, refId: basisRef.refId },
      attributes: basisRef.metadata ? { metadata: basisRef.metadata } : undefined,
    })
  }
  for (const [index, transform] of (generation.transforms ?? []).entries()) {
    body.push({
      kind: "data",
      tag: "Transform",
      metadata: {
        id: transform.transformId,
        index,
        kind: transform.kind,
        appliedAt: transform.appliedAt,
      },
      attributes: { payload: transform.payload ?? {} },
    })
  }
  if (generation.materializedContext !== null && generation.materializedContext !== undefined) {
    const text = String(generation.materializedContext)
    const usesBlockText = text.includes("\n")
    body.push({
      kind: "text",
      tag: "MaterializedContext",
      metadata: omitUndefined({
        id: `${generation.promptGenerationId}.ctx`,
        blockText: usesBlockText ? true : undefined,
      }),
      text: usesBlockText ? `\n${text}\n` : text,
    })
  }
  return body
}

async function migrateLegacyPromptGenerationFiles(params: {
  sessionDir: string
  sourceDir: string
  targetFile: string
}): Promise<{ migrated: number; quarantinedPaths: string[] }> {
  const files = (await listFilesRecursive(params.sourceDir))
    .filter((filePath) => path.extname(filePath) === ".json")
  let migrated = 0
  const quarantinedPaths: string[] = []
  for (const filePath of files) {
    const generation = await readJsonBestEffort<any>(filePath, null)
    if (generation && typeof generation === "object") {
      await appendXnlRecord({
        filePath: params.targetFile,
        tag: "PromptGeneration",
        metadata: omitUndefined({
          version: generation.version,
          id: generation.promptGenerationId,
          sessionId: generation.sessionId,
          actorKey: generation.actorKey,
          actorId: generation.actorId,
          basedOnPromptGenerationId: generation.basedOnPromptGenerationId,
          reason: generation.createdReason,
          sealed: generation.sealed,
          createdAt: generation.createdAt,
          sealedAt: generation.sealedAt,
          updatedAt: generation.updatedAt,
        }),
        attributes: omitUndefined({
          authority: {
            kind: "audit",
            recoverable: true,
            cache: false,
          },
          metadata: generation.metadata,
        }),
        body: legacyPromptGenerationBody(generation),
      })
      migrated += 1
    }
    const quarantined = await quarantineLegacyAppendOnlyPath({
      sessionDir: params.sessionDir,
      filePath,
    })
    if (quarantined) quarantinedPaths.push(quarantined)
  }
  return { migrated, quarantinedPaths }
}

function parseJsonlRecords(raw: string): any[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((value) => value && typeof value === "object")
}

async function migrateLegacyRuntimeControlEffects(params: {
  sessionDir: string
}): Promise<{ migrated: number; quarantinedPaths: string[] }> {
  const source = path.join(getAiRuntimeControlFileStorePaths(params.sessionDir).rootDir, "effects.jsonl")
  const target = getAiRuntimeControlFileStorePaths(params.sessionDir).effectsFile
  let migrated = 0
  const quarantinedPaths: string[] = []
  if (await fileExists(source) && !existsSync(target)) {
    const records = parseJsonlRecords(await readFile(source, "utf8"))
    for (const record of records) {
      const sequence = Number(record.sequence ?? migrated + 1)
      const event = record.event
      if (!event || typeof event !== "object") continue
      await appendRuntimeControlEffectEvidenceEnvelope({
        sessionDir: params.sessionDir,
        sequence,
        event: event as AiRuntimeEffectLifecycleEvent,
      })
      migrated += 1
    }
  }
  const quarantined = await quarantineLegacyAppendOnlyPath({
    sessionDir: params.sessionDir,
    filePath: source,
  })
  if (quarantined) quarantinedPaths.push(quarantined)
  return { migrated, quarantinedPaths }
}

/**
 * The legacy actor transcript format has been removed (spec
 * transcript-complete-removal): transcript files are never read, migrated,
 * or quarantined. A session whose only conversation evidence is legacy
 * transcript files must be rejected explicitly instead of being silently
 * converted — see inspectTranscriptOnlyLegacySession.
 */
export const FILE_STORE_TRANSCRIPT_ONLY_SESSION_ERROR_CODE =
  "runtime_control_session_upgrade_rejected_transcript_only_session"

export type FileStoreTranscriptOnlyLegacySessionStatus = {
  transcriptPaths: string[]
  hasConversationFiles: boolean
  transcriptOnly: boolean
}

export async function inspectTranscriptOnlyLegacySession(params: {
  sessionDir: string
}): Promise<FileStoreTranscriptOnlyLegacySessionStatus> {
  const transcriptPaths = (await listFilesRecursive(path.join(params.sessionDir, "actors")))
    .filter((filePath) => path.basename(filePath) === "transcript.txt" || path.basename(filePath) === "transcript.xnl")
  const conversationFiles = await listFilesRecursive(path.join(params.sessionDir, "conversation"))
  const hasConversationFiles = conversationFiles.length > 0
  return {
    transcriptPaths,
    hasConversationFiles,
    transcriptOnly: transcriptPaths.length > 0 && !hasConversationFiles,
  }
}

export function buildTranscriptOnlySessionRejectionError(status: FileStoreTranscriptOnlyLegacySessionStatus): Error {
  return new Error(
    [
      FILE_STORE_TRANSCRIPT_ONLY_SESSION_ERROR_CODE,
      "the actor transcript format has been removed and transcript files are no longer read",
      `this session only contains legacy transcript files (${status.transcriptPaths.length}) and no conversation files, so it cannot be upgraded or recovered`,
    ].join(": "),
  )
}

export async function inspectLegacyAppendOnlySessionFiles(params: {
  sessionDir: string
}): Promise<FileStoreLegacyAppendOnlySessionFilesStatus> {
  const conversationDir = path.join(params.sessionDir, "conversation")
  const paths = [
    ...(await listFilesRecursive(path.join(conversationDir, "history-generations")))
      .filter((filePath) => path.extname(filePath) === ".json"),
    ...(await listFilesRecursive(path.join(conversationDir, "prompt-generations")))
      .filter((filePath) => path.extname(filePath) === ".json"),
    ...((await fileExists(path.join(getAiRuntimeControlFileStorePaths(params.sessionDir).rootDir, "effects.jsonl")))
      ? [path.join(getAiRuntimeControlFileStorePaths(params.sessionDir).rootDir, "effects.jsonl")]
      : []),
  ].sort()
  return {
    hasLegacyAppendOnlyFiles: paths.length > 0,
    paths,
  }
}

export async function migrateLegacyAppendOnlySessionFilesToXnl(params: {
  sessionDir: string
}): Promise<FileStoreAppendOnlyXnlMigrationResult> {
  const conversationDir = path.join(params.sessionDir, "conversation")
  const history = await migrateLegacyHistoryGenerationFiles({
    sessionDir: params.sessionDir,
    sourceDir: path.join(conversationDir, "history-generations"),
    targetFile: path.join(conversationDir, "history.xnl"),
  })
  const prompts = await migrateLegacyPromptGenerationFiles({
    sessionDir: params.sessionDir,
    sourceDir: path.join(conversationDir, "prompt-generations"),
    targetFile: path.join(conversationDir, "prompts.xnl"),
  })
  const effects = await migrateLegacyRuntimeControlEffects(params)

  return {
    migrated: {
      historyGenerations: history.migrated,
      promptGenerations: prompts.migrated,
      runtimeControlEffects: effects.migrated,
    },
    quarantinedPaths: [
      ...history.quarantinedPaths,
      ...prompts.quarantinedPaths,
      ...effects.quarantinedPaths,
    ],
  }
}

function xnlMetadataValue(value: any): unknown {
  if (value && typeof value === "object" && value.kind === "TextElement") {
    try {
      return JSON.parse(String(value.text ?? ""))
    } catch {
      return String(value.text ?? "")
    }
  }
  return value
}

function xnlBodyValue(value: any): unknown {
  if (value && typeof value === "object" && value.kind === "TextElement") {
    try {
      return JSON.parse(String(value.text ?? ""))
    } catch {
      return String(value.text ?? "")
    }
  }
  return value
}

async function readRuntimeControlXnlReplayEvents(filePath: string, tags: string | string[]): Promise<RuntimeControlReplayEvent[]> {
  const allowedTags = new Set(Array.isArray(tags) ? tags : [tags])
  try {
    const raw = await readFile(filePath, "utf8")
    const doc = parseXnl(raw)
    return doc.nodes
      .filter((node: any) => (node?.kind === "DataElement" || node?.kind === "TextElement") && allowedTags.has(node?.tag))
      .map((node: any) => ({
        tag: node.tag,
        metadata: Object.fromEntries(
          Object.entries(node.metadata ?? {}).map(([key, value]) => [key, xnlMetadataValue(value)]),
        ),
        body: node.kind === "TextElement"
          ? [String(node.text ?? "")]
          : Array.isArray(node.body) ? node.body.map(xnlBodyValue) : [],
      }))
  } catch {
    return []
  }
}

export async function readRuntimeControlIngressReplayEvents(sessionDir: string): Promise<RuntimeControlReplayEvent[]> {
  return await readRuntimeControlXnlReplayEvents(path.join(sessionDir, "logs", "ingress.xnl"), [
    "IngressEvent",
    "ThinkDelta",
    "ContentDelta",
    "ToolDelta",
    "ControlEvent",
    "IngressDataEvent",
  ])
}

export async function readRuntimeControlDiagnosticsReplayEvents(sessionDir: string): Promise<RuntimeControlReplayEvent[]> {
  return await readRuntimeControlXnlReplayEvents(path.join(sessionDir, "logs", "diagnostics.xnl"), "DiagnosticEvent")
}

async function listFilesRecursive(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      const child = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        files.push(...await listFilesRecursive(child))
      } else if (entry.isFile()) {
        files.push(child)
      }
    }
    return files.sort()
  } catch {
    return []
  }
}

function maxControlSignalSequence(value: any): number {
  const signals = [
    ...Object.values(value?.sessionState?.controlSignals?.consumedTombstones ?? {}),
    ...Object.values(value?.sessionState?.controlSignals?.pending ?? {}),
  ] as any[]
  return signals.reduce((max, signal) => {
    const sequence = typeof signal?.sequence === "number" ? signal.sequence : 0
    return Math.max(max, sequence)
  }, 0)
}

function countMailboxEntries(value: any): number {
  const actors = Object.values(value?.actors ?? {}) as any[]
  return actors.reduce((total, actor) => {
    const mailboxes = actor?.mailboxes ?? {}
    return total + Object.values(mailboxes).reduce((sum: number, entries: any) => {
      return sum + (Array.isArray(entries) ? entries.length : 0)
    }, 0)
  }, 0)
}

export async function readRealSessionDurableHeads(sessionDir: string): Promise<Record<string, RealSessionDurableHeadState>> {
  const runtimeStateManifest = await readJsonBestEffort<any>(path.join(sessionDir, "runtime_state", "manifest.json"), null)
  const legacySnapshotManifest = await readJsonBestEffort<any>(path.join(sessionDir, "snapshot", "manifest.json"), null)
  const snapshotManifest = runtimeStateManifest ?? legacySnapshotManifest
  const conversationIndex = await readJsonBestEffort<any>(path.join(sessionDir, "conversation", "history.index.json"), null)
  const runtimeStateVm = await readJsonBestEffort<any>(path.join(sessionDir, "runtime_state", "vm.json"), null)
  const legacySnapshotVm = await readJsonBestEffort<any>(path.join(sessionDir, "snapshot", "vm.json"), null)
  const vm = runtimeStateVm ?? legacySnapshotVm
  const [ingressHead, diagnosticsHead] = await Promise.all([
    readOrInitializeObservationJournalHead({
      sessionDir,
      kind: "ingress_log",
      filePath: path.join(sessionDir, "logs", "ingress.xnl"),
    }),
    readOrInitializeObservationJournalHead({
      sessionDir,
      kind: "diagnostics_log",
      filePath: path.join(sessionDir, "logs", "diagnostics.xnl"),
    }),
  ])
  const conversationSequence = typeof conversationIndex?.updatedAt === "string"
    ? Date.parse(conversationIndex.updatedAt)
    : 0

  return {
    runtime_snapshot: {
      headId: "runtime_snapshot",
      kind: "runtime_snapshot",
      committedSequence: typeof snapshotManifest?.version === "number" ? snapshotManifest.version : 0,
      value: snapshotManifest,
    },
    conversation: {
      headId: "conversation",
      kind: "conversation_head",
      committedSequence: Number.isFinite(conversationSequence) ? conversationSequence : 0,
      value: conversationIndex,
    },
    mailbox: {
      headId: "mailbox",
      kind: "mailbox_head",
      committedSequence: countMailboxEntries(vm),
    },
    control_signals: {
      headId: "control_signals",
      kind: "control_signal_head",
      committedSequence: maxControlSignalSequence(vm),
    },
    ingress_log: {
      headId: "ingress_log",
      kind: "ingress_log",
      committedSequence: ingressHead.count,
      value: {
        eventCount: ingressHead.count,
        lastTag: ingressHead.lastTag,
        lastObservedAt: ingressHead.lastObservedAt,
      },
    },
    diagnostics_log: {
      headId: "diagnostics_log",
      kind: "diagnostics_log",
      committedSequence: diagnosticsHead.count,
      value: {
        eventCount: diagnosticsHead.count,
        lastTag: diagnosticsHead.lastTag,
        lastSequence: diagnosticsHead.lastSequence,
        lastEmittedAt: diagnosticsHead.lastObservedAt,
      },
    },
  }
}

export async function readRuntimeControlEffectEvidenceEnvelopes(
  sessionDir: string,
): Promise<RuntimeControlEffectEvidenceEnvelope[]> {
  const paths = getAiRuntimeControlFileStorePaths(sessionDir)
  const records = [
    ...await readXnlRecords({ filePath: paths.effectsFile, tag: "RuntimeEffectEvent" }),
    ...await readXnlRecords({ filePath: paths.effectsFile, tag: "runtime-control-effect" }),
  ]
  return records
    .map((record) => xnlRecordToRuntimeControlEffectEvidenceEnvelope(record))
    .filter((envelope) => envelope.sequence > 0 && envelope.event && typeof envelope.event === "object")
    .sort((left, right) => left.sequence - right.sequence)
}

function xnlRecordToRuntimeControlEffectEvidenceEnvelope(
  record: XnlStreamRecord,
): RuntimeControlEffectEvidenceEnvelope {
  if (record.tag === "runtime-control-effect") {
    const body = record.body.find((item) => item.kind === "data" && item.tag === "event")
      ?? record.body.find((item) => item.kind === "data")
    return {
      sequence: Number(record.metadata.sequence ?? 0),
      event: body?.kind === "data" ? body.attributes as AiRuntimeEffectLifecycleEvent : undefined as any,
    }
  }

  const event = runtimeEffectEventRecordToLifecycleEvent(record)
  return {
    sequence: Number(record.metadata.sequence ?? 0),
    event: event ?? undefined as any,
  }
}

function runtimeEffectEventRecordToLifecycleEvent(record: XnlStreamRecord): AiRuntimeEffectLifecycleEvent | null {
  const kind = record.metadata.kind
  const common = {
    effectKind: String(record.metadata.effectKind ?? "") as AiRuntimeEffectLifecycleEvent["effectKind"],
    effectId: String(record.metadata.effectId ?? ""),
    handlerKey: String(record.metadata.handlerKey ?? ""),
  }
  if (kind === "request") {
    const request = getXnlDataUniqueChild(record, "Request")
    return omitUndefined({
      kind: "request",
      ...common,
      idempotencyKey: String(record.metadata.idempotencyKey ?? ""),
      sourceCommandId: record.metadata.sourceCommandId,
      payload: runtimeEffectSubjectPayload(request?.attributes),
    }) as AiRuntimeEffectLifecycleEvent
  }
  if (kind === "waiting") {
    const wait = getXnlDataUniqueChild(record, "Wait")
    return omitUndefined({
      kind: "waiting",
      ...common,
      idempotencyKey: String(record.metadata.idempotencyKey ?? ""),
      waitReason: String(record.metadata.waitReason ?? ""),
      payload: runtimeEffectSubjectPayload(wait?.attributes),
    }) as AiRuntimeEffectLifecycleEvent
  }
  if (kind === "result") {
    const result = getXnlDataUniqueChild(record, "Result")
    return omitUndefined({
      kind: "result",
      ...common,
      resultId: String(record.metadata.resultId ?? ""),
      payload: runtimeEffectSubjectPayload(result?.attributes),
    }) as AiRuntimeEffectLifecycleEvent
  }
  if (kind === "failed") {
    const error = getXnlDataUniqueChild(record, "Error")
    return {
      kind: "failed",
      ...common,
      error: String(error?.attributes?.message ?? ""),
      retryable: Boolean(record.metadata.retryable ?? error?.attributes?.retryable ?? false),
    }
  }
  return null
}

function runtimeEffectSubjectPayload(attributes: Record<string, unknown> | undefined): unknown {
  if (!attributes) return undefined
  if (Object.prototype.hasOwnProperty.call(attributes, "payload") && Object.keys(attributes).length === 1) {
    return attributes.payload
  }
  if (Object.prototype.hasOwnProperty.call(attributes, "value") && Object.keys(attributes).length === 1) {
    return attributes.value
  }
  return attributes
}

export async function appendRuntimeControlEffectEvidence(params: {
  sessionDir: string
  event: AiRuntimeEffectLifecycleEvent
}): Promise<RuntimeControlEffectEvidenceEnvelope> {
  const paths = getAiRuntimeControlFileStorePaths(params.sessionDir)
  const queueKey = paths.effectsFile
  const previous = effectEvidenceAppendQueues.get(queueKey) ?? Promise.resolve()
  const write = previous
    .catch(() => {})
    .then(async () => {
      await mkdir(path.dirname(paths.effectsFile), { recursive: true })
      const sequence = await readRuntimeControlEffectEvidenceSequenceUnlocked(params.sessionDir) + 1
      const envelope: RuntimeControlEffectEvidenceEnvelope = {
        sequence,
        event: params.event,
      }
      await appendRuntimeControlEffectEvidenceEnvelope({
        sessionDir: params.sessionDir,
        sequence,
        event: params.event,
      })
      return envelope
    })
  effectEvidenceAppendQueues.set(queueKey, write)
  try {
    return await write
  } finally {
    if (effectEvidenceAppendQueues.get(queueKey) === write) {
      effectEvidenceAppendQueues.delete(queueKey)
    }
  }
}

export async function readRuntimeControlEffectEvidence(sessionDir: string): Promise<AiRuntimeEffectLifecycleEvent[]> {
  return (await readRuntimeControlEffectEvidenceEnvelopes(sessionDir)).map((envelope) => envelope.event)
}

export async function readRuntimeControlEffectEvidenceSequence(sessionDir: string): Promise<number> {
  const persisted = await readPersistedRuntimeControlJournalHead({
    sessionDir,
    kind: "effect_evidence",
  })
  if (persisted) return persisted.lastSequence ?? 0

  const paths = getAiRuntimeControlFileStorePaths(sessionDir)
  const previous = effectEvidenceAppendQueues.get(paths.effectsFile) ?? Promise.resolve()
  const read = previous
    .catch(() => {})
    .then(async () => await readRuntimeControlEffectEvidenceSequenceUnlocked(sessionDir))
  effectEvidenceAppendQueues.set(paths.effectsFile, read)
  try {
    return await read
  } finally {
    if (effectEvidenceAppendQueues.get(paths.effectsFile) === read) {
      effectEvidenceAppendQueues.delete(paths.effectsFile)
    }
  }
}

async function readRuntimeControlEffectEvidenceSequenceUnlocked(sessionDir: string): Promise<number> {
  const paths = getAiRuntimeControlFileStorePaths(sessionDir)
  const head = await initializeLegacyRuntimeControlJournalHead({
    sessionDir,
    kind: "effect_evidence",
    filePath: paths.effectsFile,
  })
  return head?.lastSequence ?? 0
}

export async function inferRuntimeControlCheckpointEffectEvidenceSequence(params: {
  sessionDir: string
  checkpoint?: RuntimeControlCohortCommitFile | null
}): Promise<number | null> {
  const envelopes = await readRuntimeControlEffectEvidenceEnvelopes(params.sessionDir)
  if (envelopes.length === 0) return 0
  let inferred: number | null = null
  const expectedRuntimeSnapshot = params.checkpoint?.headSequences?.runtime_snapshot
  for (const envelope of envelopes) {
    const event = envelope.event
    if (event.kind !== "result" || event.effectKind !== "runtime_checkpoint") continue
    const manifestVersion = (event.payload as any)?.manifestVersion
    if (typeof expectedRuntimeSnapshot === "number" && manifestVersion !== expectedRuntimeSnapshot) continue
    inferred = envelope.sequence
  }
  return inferred
}

export async function readRuntimeControlEffectEvidenceAfterSequence(params: {
  sessionDir: string
  sequence: number
}): Promise<AiRuntimeEffectLifecycleEvent[]> {
  return (await readRuntimeControlEffectEvidenceEnvelopes(params.sessionDir))
    .filter((envelope) => envelope.sequence > params.sequence)
    .map((envelope) => envelope.event)
}

export async function readRuntimeControlEffectEvidenceThroughSequence(params: {
  sessionDir: string
  sequence?: number
}): Promise<AiRuntimeEffectLifecycleEvent[]> {
  const envelopes = await readRuntimeControlEffectEvidenceEnvelopes(params.sessionDir)
  if (typeof params.sequence !== "number") return envelopes.map((envelope) => envelope.event)
  const sequence = params.sequence
  return envelopes
    .filter((envelope) => envelope.sequence <= sequence)
    .map((envelope) => envelope.event)
}
