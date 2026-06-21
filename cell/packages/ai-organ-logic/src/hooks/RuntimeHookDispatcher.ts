import type {
  RuntimeHookDefinition,
  RuntimeHookDispatchReport,
  RuntimeHookDispatchStepReport,
  RuntimeHookEffect,
  RuntimeHookInvocationContext,
  RuntimeHookResult,
} from "@cell/ai-core-contract"
import {
  runByFuncStyleAdapter,
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"

export type RuntimeHookHandlerRuntime = {
  definition: RuntimeHookDefinition
  context: RuntimeHookInvocationContext
  data?: Record<string, unknown>
}

export type RuntimeHookHandlerComponent = {
  outerDerivedAdapter?: (
    runtime: RuntimeHookHandlerRuntime,
    input: RuntimeHookInvocationContext,
    config: unknown,
  ) => unknown
  innerRuntimeAdapter?: (
    runtime: RuntimeHookHandlerRuntime,
    input: RuntimeHookInvocationContext,
    config: unknown,
    derived: any,
  ) => unknown
  innerInputAdapter?: (
    runtime: RuntimeHookHandlerRuntime,
    input: RuntimeHookInvocationContext,
    config: unknown,
    derived: any,
  ) => unknown
  innerConfigAdapter?: (
    runtime: RuntimeHookHandlerRuntime,
    input: RuntimeHookInvocationContext,
    config: unknown,
    derived: any,
  ) => unknown
  coreLogic: (
    runtime: any,
    input: any,
    config: any,
  ) => Promise<RuntimeHookResult> | RuntimeHookResult
  outerOutputAdapter?: (
    runtime: RuntimeHookHandlerRuntime,
    input: RuntimeHookInvocationContext,
    config: unknown,
    derived: any,
    output: RuntimeHookResult,
  ) => RuntimeHookResult
  config?: unknown
}

export type RuntimeHookDispatchParams = {
  definitions: readonly RuntimeHookDefinition[]
  context: RuntimeHookInvocationContext
  budgetMs?: number
  maxHooks?: number
  runtimeData?: Record<string, unknown>
  beforeHook?: (definition: RuntimeHookDefinition) => boolean | Promise<boolean>
  afterHook?: (params: {
    definition: RuntimeHookDefinition
    result: RuntimeHookResult
    stepIndex: number
  }) => void | Promise<void>
}

export type RuntimeHookDispatchOutput = {
  result: RuntimeHookResult
  report: RuntimeHookDispatchReport
}

export type RuntimeHookDispatcher = {
  dispatch: (params: RuntimeHookDispatchParams) => Promise<RuntimeHookDispatchOutput>
}

export type RuntimeHookDispatcherOptions = {
  handlers: Readonly<Record<string, RuntimeHookHandlerComponent | undefined>>
  now?: () => number
  activeGuardKeys?: Set<string>
}

export function createRuntimeHookHandlerComponent(
  component: RuntimeHookHandlerComponent,
): RuntimeHookHandlerComponent {
  return component
}

function getHookPhase(point: string): string {
  return point.split(".").at(-1) ?? ""
}

function phaseRank(point: string): number {
  switch (getHookPhase(point)) {
    case "before":
      return 0
    case "around":
      return 1
    case "after":
      return 2
    case "error":
      return 3
    default:
      return 4
  }
}

function compareHookDefinitions(a: RuntimeHookDefinition, b: RuntimeHookDefinition): number {
  return (
    phaseRank(a.point) - phaseRank(b.point)
    || (b.priority ?? 0) - (a.priority ?? 0)
    || a.extensionId.localeCompare(b.extensionId)
    || a.name.localeCompare(b.name)
  )
}

function includesIfPresent(values: readonly string[] | undefined, value: string | undefined): boolean {
  if (!values?.length) return true
  return value !== undefined && values.includes(value)
}

function tagsMatch(matcherTags: readonly string[] | undefined, actualTags: readonly string[] | undefined): boolean {
  if (!matcherTags?.length) return true
  if (!actualTags?.length) return false
  return matcherTags.every((tag) => actualTags.includes(tag))
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
  return new RegExp(`^${escaped}$`)
}

function pathGlobsMatch(globs: readonly string[] | undefined, value: string | undefined): boolean {
  if (!globs?.length) return true
  if (!value) return false
  return globs.some((glob) => globToRegExp(glob).test(value))
}

function matchesHook(definition: RuntimeHookDefinition, context: RuntimeHookInvocationContext): boolean {
  if (definition.enabled === false) return false
  if (definition.point !== context.point) return false

  const matcher = definition.matcher
  if (!matcher) return true

  return (
    includesIfPresent(matcher.actorIds, context.actorId)
    && includesIfPresent(matcher.actorNames, context.actorName)
    && includesIfPresent(matcher.actorKinds, context.actorKind)
    && includesIfPresent(matcher.toolNames, context.toolName)
    && includesIfPresent(matcher.providerIds, context.providerId)
    && includesIfPresent(matcher.shellTypes, context.shellType)
    && includesIfPresent(matcher.commandNames, context.commandName)
    && includesIfPresent(matcher.extensionIds, context.extensionId)
    && includesIfPresent(matcher.subjectPaths, context.subjectPath)
    && includesIfPresent(matcher.riskLevels, context.riskLevel)
    && pathGlobsMatch(matcher.pathGlobs, context.subjectPath)
    && tagsMatch(matcher.tags, context.tags)
  )
}

function makeGuardKey(context: RuntimeHookInvocationContext): string {
  return [
    context.sessionId ?? "",
    context.actorId ?? context.actorName ?? "",
    context.point,
    context.traceId ?? "",
  ].join(":")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
): Promise<{ status: "ok"; value: T } | { status: "timed_out" }> {
  if (!timeoutMs || timeoutMs <= 0) {
    return { status: "ok", value: await promise }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then((value) => ({ status: "ok" as const, value })),
      new Promise<{ status: "timed_out" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timed_out" }), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function invokeHookComponent(params: {
  component: RuntimeHookHandlerComponent
  definition: RuntimeHookDefinition
  context: RuntimeHookInvocationContext
  runtimeData?: Record<string, unknown>
}): Promise<RuntimeHookResult> {
  return await runByFuncStyleAdapter(
    {
      definition: params.definition,
      context: params.context,
      data: params.runtimeData,
    },
    params.context,
    params.component.config,
    params.component.outerDerivedAdapter ?? stdMakeNullOuterComputed,
    params.component.innerRuntimeAdapter ?? stdMakeIdentityInnerRuntime,
    params.component.innerInputAdapter ?? stdMakeIdentityInnerInput,
    params.component.innerConfigAdapter ?? stdMakeIdentityInnerConfig,
    params.component.coreLogic,
    params.component.outerOutputAdapter ?? stdMakeIdentityOuterOutput,
  )
}

export function createRuntimeHookDispatcher(options: RuntimeHookDispatcherOptions): RuntimeHookDispatcher {
  const activeGuardKeys = options.activeGuardKeys ?? new Set<string>()
  const now = options.now ?? (() => Date.now())

  return {
    async dispatch(params): Promise<RuntimeHookDispatchOutput> {
      const startedAt = now()
      const matched = params.definitions
        .filter((definition) => matchesHook(definition, params.context))
        .sort(compareHookDefinitions)
      const guardKey = makeGuardKey(params.context)

      if (activeGuardKeys.has(guardKey)) {
        const steps: RuntimeHookDispatchStepReport[] = matched.map((definition) => ({
          hookName: definition.name,
          extensionId: definition.extensionId,
          point: definition.point,
          mode: definition.mode,
          status: "reentrant_skipped",
          message: "runtime hook dispatch skipped because the same guard key is already active",
        }))
        const result: RuntimeHookResult = { action: "continue" }
        return {
          result,
          report: {
            eventType: "hook_dispatch_report",
            point: params.context.point,
            sessionId: params.context.sessionId,
            actorId: params.context.actorId,
            actorName: params.context.actorName,
            traceId: params.context.traceId,
            finalAction: result.action,
            elapsedMs: now() - startedAt,
            steps,
            payload: params.context.payload,
          },
        }
      }

      activeGuardKeys.add(guardKey)
      const steps: RuntimeHookDispatchStepReport[] = []
      const effects: RuntimeHookEffect[] = []
      let finalResult: RuntimeHookResult = { action: "continue" }

      try {
        for (const definition of matched) {
          if (params.maxHooks !== undefined && steps.length >= params.maxHooks) {
            steps.push({
              hookName: definition.name,
              extensionId: definition.extensionId,
              point: definition.point,
              mode: definition.mode,
              status: "budget_exhausted",
              message: "runtime hook dispatch reached max hook count",
            })
            finalResult = { action: "stop" }
            break
          }

          if (params.budgetMs !== undefined && now() - startedAt >= params.budgetMs) {
            steps.push({
              hookName: definition.name,
              extensionId: definition.extensionId,
              point: definition.point,
              mode: definition.mode,
              status: "budget_exhausted",
              message: "runtime hook dispatch reached elapsed budget",
            })
            finalResult = { action: "stop" }
            break
          }

          const component = options.handlers[definition.execution.componentId]
          const stepStartedAt = now()

          if (params.beforeHook && !(await params.beforeHook(definition))) {
            steps.push({
              hookName: definition.name,
              extensionId: definition.extensionId,
              point: definition.point,
              mode: definition.mode,
              status: "skipped",
              elapsedMs: now() - stepStartedAt,
              message: "runtime hook dispatch stopped because lifecycle state is no longer current",
            })
            finalResult = { action: "stop" }
            break
          }

          if (!component) {
            steps.push({
              hookName: definition.name,
              extensionId: definition.extensionId,
              point: definition.point,
              mode: definition.mode,
              status: "skipped",
              elapsedMs: now() - stepStartedAt,
              message: `runtime hook handler not found: ${definition.execution.componentId}`,
            })
            if (definition.failOpen === false) {
              finalResult = { action: "stop" }
              break
            }
            continue
          }

          try {
            const timed = await withTimeout(
              invokeHookComponent({
                component,
                definition,
                context: params.context,
                runtimeData: params.runtimeData,
              }),
              definition.timeoutMs,
            )

            if (timed.status === "timed_out") {
              steps.push({
                hookName: definition.name,
                extensionId: definition.extensionId,
                point: definition.point,
                mode: definition.mode,
                status: "timed_out",
                elapsedMs: now() - stepStartedAt,
                message: "runtime hook handler timed out",
              })
              if (definition.failOpen === false) {
                finalResult = { action: "stop" }
                break
              }
              continue
            }

            finalResult = timed.value
            if (timed.value.effects?.length) {
              effects.push(...timed.value.effects)
            }
            await params.afterHook?.({
              definition,
              result: timed.value,
              stepIndex: steps.length,
            })
            steps.push({
              hookName: definition.name,
              extensionId: definition.extensionId,
              point: definition.point,
              mode: definition.mode,
              status: "matched",
              action: timed.value.action,
              elapsedMs: now() - stepStartedAt,
              metadata: timed.value.metadata,
            })

            if (timed.value.action === "stop" || timed.value.action === "deny" || timed.value.action === "ask") {
              break
            }
          } catch (error) {
            steps.push({
              hookName: definition.name,
              extensionId: definition.extensionId,
              point: definition.point,
              mode: definition.mode,
              status: "failed",
              elapsedMs: now() - stepStartedAt,
              error: errorMessage(error),
            })
            if (definition.failOpen === false) {
              finalResult = { action: "stop" }
              break
            }
          }
        }
      } finally {
        activeGuardKeys.delete(guardKey)
      }

      const result: RuntimeHookResult = {
        ...finalResult,
        effects: effects.length ? effects : finalResult.effects,
      }

      return {
        result,
        report: {
          eventType: "hook_dispatch_report",
          point: params.context.point,
          sessionId: params.context.sessionId,
          actorId: params.context.actorId,
          actorName: params.context.actorName,
          traceId: params.context.traceId,
          finalAction: result.action,
          elapsedMs: now() - startedAt,
          steps,
          payload: params.context.payload,
          output: result.output,
          effects: result.effects,
        },
      }
    },
  }
}
