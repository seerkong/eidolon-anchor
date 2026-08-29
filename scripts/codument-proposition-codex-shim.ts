#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"

import {
  buildEidolonPropositionShimArgv,
  buildRegisteredPropositionWorkflowPrepareArgv,
  buildRegisteredPropositionWorkflowRunArgv,
  createAllowlistedPropositionEnvironment,
  materializeRegisteredPropositionWorkflow,
  parseCodexCompatibleExecInvocation,
  registeredPropositionWorkflowBinding,
} from "../testkit/codument-proposition/support.ts"
import type { CodumentPropositionMode } from "../testkit/codument-proposition/contract.ts"
import { resolveCodumentPropositionProviderBinding } from "../testkit/codument-proposition/contract.ts"
import { projectCanonicalPropositionProviderTurns } from "../testkit/codument-proposition/harness.ts"
import type { ProviderCacheCostObservation } from "../cell/packages/ai-organ-contract/src/llm/ProviderCacheCostObservation.ts"

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function exactMode(value: string): CodumentPropositionMode {
  if (value === "ordinary" || value === "ai_ctrl" || value === "ai_data") return value
  throw new Error(`unsupported EIDOLON_PROPOSITION_MODE: ${value}`)
}

function countEvidenceRecords(evidencePath: string): number {
  if (!existsSync(evidencePath)) return 0
  return readFileSync(evidencePath, "utf8").split("\n").filter((line) => line.trim()).length
}

function parseResult(stdout: string): Record<string, unknown> {
  const candidates = [stdout, ...stdout.split("\n").reverse().filter((line) => line.trim().startsWith("{"))]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && (typeof parsed.kind === "string" || typeof parsed.status === "string")) {
        return parsed as Record<string, unknown>
      }
    } catch {}
  }
  throw new Error("Eidolon proposition child emitted no structured JSON result")
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    : []
}

function projectModeIdentity(mode: CodumentPropositionMode, sessionId: string, result: Record<string, unknown>) {
  const executions = records(result.workflowExecutions)
  if (mode === "ordinary") {
    if (executions.length !== 0) throw new Error("ordinary proposition execution emitted Workflow evidence")
    return Object.freeze({
      requestedMode: mode,
      actualMode: mode,
      sessionId,
      evidenceSource: "terminal.runtime.public-events/v1" as const,
      workflow: null,
    })
  }
  const expectedKind = mode === "ai_ctrl" ? "AICtrlWorkflow" : "AIDataWorkflow"
  const matching = executions.filter((entry) => entry.kind === expectedKind)
  if (matching.length !== 1) {
    throw new Error(`expected exactly one public ${expectedKind} execution, observed ${matching.length}`)
  }
  const execution = matching[0]!
  const nodes = records(execution.nodeExecutions)
  if (nodes.length === 0) throw new Error(`${expectedKind} execution emitted no node Actor evidence`)
  const node = nodes[0]!
  for (const [label, value] of Object.entries({
    definitionRef: execution.definitionRef,
    instanceId: execution.instanceId,
    runId: execution.runId,
    nodeActorId: node.actorId,
  })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${expectedKind} public evidence lacks ${label}`)
  }
  return Object.freeze({
    requestedMode: mode,
    actualMode: mode,
    sessionId,
    evidenceSource: "terminal.runtime.public-events/v1" as const,
    workflow: Object.freeze({
      kind: expectedKind,
      definitionRef: execution.definitionRef as string,
      instanceId: execution.instanceId as string,
      runId: execution.runId as string,
      nodeActorId: node.actorId as string,
    }),
  })
}

function projectProviderAttempts(result: Record<string, unknown>) {
  const timing = result.timing && typeof result.timing === "object" && !Array.isArray(result.timing)
    ? result.timing as Record<string, unknown>
    : {}
  const counts = timing.counts && typeof timing.counts === "object" && !Array.isArray(timing.counts)
    ? timing.counts as Record<string, unknown>
    : {}
  const calls = timing.providerCalls && typeof timing.providerCalls === "object" && !Array.isArray(timing.providerCalls)
    ? records((timing.providerCalls as Record<string, unknown>).entries)
    : []
  const providerCallProjection = timing.providerCalls && typeof timing.providerCalls === "object" && !Array.isArray(timing.providerCalls)
    ? timing.providerCalls as Record<string, unknown>
    : {}
  const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
  return Object.freeze({
    providerCalls: integer(counts.providerCalls),
    providerFailures: integer(counts.providerFailures),
    providerRetries: integer(counts.providerRetries),
    finalAttemptTerminalCauses: Object.freeze(calls.map((entry) => String(entry.terminalCause ?? "unknown"))),
    finalAttemptTerminalCauseOmittedCount: integer(providerCallProjection.omittedCount),
  })
}

function projectProviderEvidence(result: Record<string, unknown>, contextScopeId: string) {
  const observations = records(result.providerCacheObservations) as ProviderCacheCostObservation[]
  const epochReasons = observations.map((observation, index) => {
    if (index === 0) return "initial_projection"
    return observation.identity.contextEpoch === observations[index - 1]!.identity.contextEpoch
      ? "stable_epoch"
      : "runtime_epoch_transition"
  })
  const providerTurns = projectCanonicalPropositionProviderTurns({ contextScopeId, observations, epochReasons })
  return Object.freeze({
    providerTurns,
    providerAttempts: projectProviderAttempts(result),
  })
}

async function runChild(
  argv: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<Readonly<{ stdout: string; stderr: string; exitCode: number }>> {
  const child = Bun.spawn(argv, {
    cwd,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return Object.freeze({ stdout, stderr, exitCode })
}

async function main(): Promise<void> {
  const mode = exactMode(requiredEnvironment("EIDOLON_PROPOSITION_MODE"))
  const provider = resolveCodumentPropositionProviderBinding(
    requiredEnvironment("EIDOLON_PROPOSITION_PROVIDER_BINDING"),
  )
  const evidencePath = path.resolve(requiredEnvironment("EIDOLON_PROPOSITION_EVIDENCE"))
  const runId = requiredEnvironment("EIDOLON_PROPOSITION_RUN_ID").replace(/[^A-Za-z0-9_-]/g, "-")
  const eidolonExecutable = process.env.EIDOLON_PROPOSITION_EXECUTABLE?.trim() || "eidolon"
  const stdin = process.argv.includes("-") ? await Bun.stdin.text() : undefined
  const invocation = parseCodexCompatibleExecInvocation(process.argv.slice(2), stdin, process.cwd())
  const ordinal = countEvidenceRecords(evidencePath) + 1
  const sessionId = `codument-e2e-${runId}-${mode}-${ordinal}`
  const artifactRoot = path.join(path.dirname(evidencePath), "artifacts", `${mode}-${ordinal}`)
  const tracePath = path.join(artifactRoot, "exec-trace.jsonl")
  mkdirSync(artifactRoot, { recursive: true })
  const environment = createAllowlistedPropositionEnvironment(process.env, [
    "HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TMPDIR", "USERPROFILE", "XDG_CONFIG_HOME",
  ])
  const startedAt = new Date().toISOString()
  let childResult: Readonly<{ stdout: string; stderr: string; exitCode: number }>
  if (mode === "ordinary") {
    childResult = await runChild(buildEidolonPropositionShimArgv({
      eidolonExecutable,
      invocation,
      mode,
      provider,
      sessionId,
      tracePath,
    }), invocation.cwd, environment)
  } else {
    const binding = registeredPropositionWorkflowBinding(mode, `${runId}-${ordinal}`)
    await materializeRegisteredPropositionWorkflow({ workspaceRoot: invocation.cwd, binding })
    const prepared = await runChild(buildRegisteredPropositionWorkflowPrepareArgv({
      eidolonExecutable,
      provider,
      sessionId,
      binding,
      request: invocation.prompt,
    }), invocation.cwd, environment)
    if (prepared.exitCode !== 0) {
      throw new Error(`registered proposition Workflow prepare failed: ${prepared.stderr || prepared.stdout}`)
    }
    const prepareResult = parseResult(prepared.stdout)
    const preparedInstance = prepareResult.instance && typeof prepareResult.instance === "object"
      && !Array.isArray(prepareResult.instance)
      ? prepareResult.instance as Record<string, unknown>
      : {}
    if (preparedInstance.instanceId !== binding.instanceId) {
      throw new Error("registered proposition Workflow prepare returned a different instance")
    }
    const executed = await runChild(buildRegisteredPropositionWorkflowRunArgv({
      eidolonExecutable,
      provider,
      sessionId,
      binding,
    }), invocation.cwd, environment)
    childResult = Object.freeze({
      stdout: executed.stdout,
      stderr: [prepared.stderr, executed.stderr].filter((value) => value.trim()).join("\n"),
      exitCode: executed.exitCode,
    })
  }
  const { stdout, stderr, exitCode } = childResult
  const result = parseResult(stdout)
  const finishedAt = new Date().toISOString()
  const requestDigest = `sha256:${createHash("sha256").update(invocation.prompt, "utf8").digest("hex")}`
  const propositionRequestDigest = requiredEnvironment("EIDOLON_PROPOSITION_REQUEST_DIGEST")
  if (!/^sha256:[a-f0-9]{64}$/.test(propositionRequestDigest)) {
    throw new Error("EIDOLON_PROPOSITION_REQUEST_DIGEST must be a canonical sha256 digest")
  }
  let modeIdentity: ReturnType<typeof projectModeIdentity> | null = null
  let providerEvidence: ReturnType<typeof projectProviderEvidence> = Object.freeze({
    providerTurns: Object.freeze([]),
    providerAttempts: projectProviderAttempts(result),
  })
  const evidenceErrors: string[] = []
  try {
    providerEvidence = projectProviderEvidence(result, sessionId)
  } catch (error) {
    evidenceErrors.push(`provider: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    modeIdentity = projectModeIdentity(mode, sessionId, result)
  } catch (error) {
    evidenceErrors.push(`mode: ${error instanceof Error ? error.message : String(error)}`)
  }
  const evidenceError = evidenceErrors.length > 0 ? evidenceErrors.join("; ") : null
  mkdirSync(path.dirname(evidencePath), { recursive: true })
  appendFileSync(evidencePath, `${JSON.stringify({
    schemaVersion: "eidolon.codument-proposition-shim-evidence/v1",
    mode,
    modeIdentity,
    evidenceError,
    providerTurns: providerEvidence.providerTurns,
    providerAttempts: providerEvidence.providerAttempts,
    providerBindingId: provider.id,
    providerId: provider.credential.providerId,
    providerProfileId: provider.credential.profileId,
    model: provider.credential.model,
    sessionId,
    requestDigest,
    propositionRequestDigest,
    cwd: invocation.cwd,
    tracePath,
    startedAt,
    finishedAt,
    exitCode,
    result,
    stderr,
  })}\n`, { encoding: "utf8", mode: 0o600 })
  const visible = typeof result.finalMessage === "string"
    ? result.finalMessage
    : typeof result.visibleOutput === "string"
      ? result.visibleOutput
      : stdout
  process.stdout.write(visible.endsWith("\n") ? visible : `${visible}\n`)
  if (stderr.trim()) process.stderr.write(stderr)
  if (evidenceError) process.stderr.write(`[eidolon proposition evidence] ${evidenceError}\n`)
  process.exitCode = evidenceError ? 1 : exitCode
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
