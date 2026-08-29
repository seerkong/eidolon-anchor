import { describe, expect, it } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  buildEidolonPropositionShimArgv,
  buildRegisteredPropositionWorkflowPrepareArgv,
  buildRegisteredPropositionWorkflowRunArgv,
  createAllowlistedPropositionEnvironment,
  createRegisteredPropositionModeExecutionPort,
  createRegisteredOrdinaryPropositionSurface,
  createRegisteredWorkflowPropositionSurface,
  createJsonPropositionReceiptStore,
  materializeRegisteredPropositionWorkflow,
  parseCodexCompatibleExecInvocation,
  registeredPropositionWorkflowBinding,
} from "../../../../testkit/codument-proposition/support"
import { planCodumentPropositionMatrix } from "../../../../testkit/codument-proposition/matrixRunner"
import {
  providerScopeEvidenceComplete,
  prepareLiveMatrixExecutableEpoch,
  receiptAccepted,
  scenarioCatalog,
} from "../../../../scripts/run-codument-proposition-live"
import {
  assertCodumentPropositionExecutableEpoch,
  bindCodumentPropositionExecutableEpoch,
  createExecutableEpochReceiptStore,
} from "../../../../testkit/codument-proposition/liveRuntime"
import { EidolonAppResourceRegistryAdapter } from "@cell/ai-organ-logic/resources/EidolonAppResourceRegistryAdapter"
import { resolveCodumentPropositionProviderBinding } from "../../../../testkit/codument-proposition/contract"

const officialProvider = resolveCodumentPropositionProviderBinding("official-deepseek")
const iqingwaProvider = resolveCodumentPropositionProviderBinding("deepseek-iqingwa-v4-pro")

const processResult = {
  exitCode: 0,
  status: "completed" as const,
  startedAt: "2026-08-27T00:00:00.000Z",
  finishedAt: "2026-08-27T00:00:01.000Z",
  stdoutArtifact: "artifact://stdout",
  stderrArtifact: "artifact://stderr",
}

const baseInput = {
  workspaceRoot: "/tmp/workspace",
  request: new TextEncoder().encode("build the project"),
  requestDigest: `sha256:${"a".repeat(64)}` as const,
  timeoutSeconds: 60,
  credential: {
    providerId: "deepseek",
    profileId: "deepseek-official-chat@1",
    model: "deepseek-v4-flash",
  },
}

describe("Codex-compatible proposition shim", () => {
  it("loads from an arbitrary external cwd without workspace package aliases", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "eidolon-proposition-shim-cwd-"))
    try {
      const script = path.resolve(import.meta.dir, "../../../../scripts/codument-proposition-codex-shim.ts")
      const child = Bun.spawn(["bun", script, "exec", "命题"], {
        cwd,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
      expect(exitCode).toBe(1)
      expect(stderr).toContain("EIDOLON_PROPOSITION_MODE is required")
      expect(stderr).not.toContain("Cannot find module")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("projects source runner calls into exact ordinary and Workflow surfaces", () => {
    const invocation = parseCodexCompatibleExecInvocation([
      "exec", "-C", "workspace", "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox", "-m", "deepseek/deepseek-v4-flash", "原始命题",
    ], undefined, "/tmp/run")
    expect(invocation).toEqual({
      cwd: "/tmp/run/workspace",
      prompt: "原始命题",
      requestedModel: "deepseek/deepseek-v4-flash",
    })
    const common = {
      eidolonExecutable: "/opt/eidolon",
      invocation,
      provider: officialProvider,
      sessionId: "session-1",
      tracePath: "/tmp/trace.jsonl",
    } as const
    expect(buildEidolonPropositionShimArgv({ ...common, mode: "ordinary" })).toContain("exec")
    expect(() => buildEidolonPropositionShimArgv({ ...common, mode: "ai_ctrl" }))
      .toThrow("registered prepare/run surface")
    const ctrl = registeredPropositionWorkflowBinding("ai_ctrl", "run-1")
    expect(buildRegisteredPropositionWorkflowPrepareArgv({
      eidolonExecutable: common.eidolonExecutable,
      provider: common.provider,
      sessionId: common.sessionId,
      binding: ctrl,
      request: invocation.prompt,
    })).toContain("prepare")
    const run = buildRegisteredPropositionWorkflowRunArgv({
      eidolonExecutable: common.eidolonExecutable,
      provider: common.provider,
      sessionId: common.sessionId,
      binding: ctrl,
    })
    expect(run).toContain("--capture-runtime-evidence")
    expect(run).toContain("deepseek-official-chat@1")
    const compatible = buildEidolonPropositionShimArgv({
      ...common,
      invocation: { ...invocation, requestedModel: iqingwaProvider.credential.model },
      provider: iqingwaProvider,
      mode: "ordinary",
    })
    expect(compatible).toContain("deepseek-iqingwa/deepseek-v4-pro")
    expect(compatible).toContain("deepseek-compatible-chat@1")
  })

  for (const mode of ["ai_ctrl", "ai_data"] as const) it(`materializes one fixed ${mode} resource wrapper with one real Agent node`, async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), `eidolon-proposition-${mode}-`))
    try {
      const binding = registeredPropositionWorkflowBinding(mode, "run-1")
      await materializeRegisteredPropositionWorkflow({ workspaceRoot: cwd, binding })
      const resources = path.join(cwd, ".eidolon", "resources")
      const manifest = await readFile(path.join(resources, "Workflows", `${binding.directoryName}.xnl`), "utf8")
      expect(binding.definitionRef).toStartWith("resource://")
      expect(manifest).toContain(mode === "ai_ctrl" ? "<Run #execute" : "<TransformNode #execute")
      expect(manifest).toContain("resource://local.codument.proposition.CodeAgent")
      expect(await readFile(path.join(resources, "Workflows", "flow-code", "index.ts"), "utf8"))
        .toContain("runtime.ai.effects.runAgent")
      const agent = await readFile(path.join(resources, "Agents", "CodeAgent.xnl"), "utf8")
      expect(agent).toContain("<MessagePrefix")
      expect(agent).toContain("<MessageSource #workspace")
      expect(agent).toContain("<ContextPipeline")
      expect(agent).toContain('ref = "resource://bash"')
      expect(agent).toContain('ref = "resource://write"')
      const prepared = await new EidolonAppResourceRegistryAdapter({
        layers: [{ id: "workspace", rootDir: resources }],
        workspaceRoot: cwd,
      }).prepareWorkflowAgentExecution({
        workflowKind: binding.kind,
        workflowRef: binding.definitionRef,
        nodeId: "execute",
        agentDefinitionRef: "resource://local.codument.proposition.CodeAgent",
      })
      expect(prepared.plan.messages.map((message) => message.id)).toEqual(["kernel", "coding", "mission"])
      expect(prepared.plan.messages[0]?.content).toContain("工作循环")
      expect(prepared.plan.messages[1]?.content).toContain("你是主编码代理")
      expect(prepared.plan.contextPipeline?.implementation).toBe("eidolon.standard-context-pipeline/v1")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("rejects provider substitution and unsupported source-runner options", () => {
    expect(() => parseCodexCompatibleExecInvocation(["exec", "--search", "命题"], undefined, "/tmp"))
      .toThrow("unsupported codex exec option")
    const invocation = parseCodexCompatibleExecInvocation(["exec", "-m", "other/model", "命题"], undefined, "/tmp")
    expect(() => buildEidolonPropositionShimArgv({
      eidolonExecutable: "eidolon",
      invocation,
      mode: "ordinary",
      provider: officialProvider,
      sessionId: "session-1",
      tracePath: "/tmp/trace.jsonl",
    })).toThrow("different model")
  })
})

describe("proposition process environment projection", () => {
  it("forwards only explicit safe keys and never provider secrets", () => {
    expect(createAllowlistedPropositionEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      LANG: "en_US.UTF-8",
      UNDECLARED: "hidden",
      DEEPSEEK_API_KEY: "secret",
    }, ["PATH", "HOME", "LANG"])).toEqual({
      HOME: "/Users/example",
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin",
    })
    expect(() => createAllowlistedPropositionEnvironment({
      DEEPSEEK_API_KEY: "secret",
    }, ["DEEPSEEK_API_KEY"])).toThrow("secret environment key")
  })
})

describe("registered proposition mode surfaces", () => {
  it("keeps the registered ordinary surface Workflow-free", async () => {
    const surface = createRegisteredOrdinaryPropositionSurface({
      execute: async () => ({
        identity: {
          requestedMode: "ordinary",
          actualMode: "ordinary",
          sessionId: "session-ordinary",
          evidenceSource: "terminal.runtime.public-events/v1",
          workflow: null,
        },
        process: processResult,
        providerTurns: [],
        providerAttempts: { providerCalls: 0, providerFailures: 0, providerRetries: 0, finalAttemptTerminalCauses: [], finalAttemptTerminalCauseOmittedCount: 0 },
      }),
    })
    expect((await surface({ ...baseInput, mode: "ordinary" })).identity.workflow).toBeNull()
    await expect(surface({ ...baseInput, mode: "ai_ctrl" })).rejects.toThrow("ordinary proposition surface")
  })

  it("binds a fixed public Workflow definition reference", async () => {
    let observedRef = ""
    const surface = createRegisteredWorkflowPropositionSurface({
      mode: "ai_ctrl",
      workflowRef: "resource://test.ctrl",
      execute: async (input) => {
        observedRef = input.workflowRef
        return {
          identity: {
            requestedMode: "ai_ctrl",
            actualMode: "ai_ctrl",
            sessionId: "session-fixed",
            evidenceSource: "terminal.runtime.public-events/v1",
            workflow: {
              kind: "AICtrlWorkflow",
              definitionRef: input.workflowRef,
              instanceId: "instance-fixed",
              runId: "run-fixed",
              nodeActorId: "node-fixed",
            },
          },
          process: processResult,
          providerTurns: [],
          providerAttempts: { providerCalls: 0, providerFailures: 0, providerRetries: 0, finalAttemptTerminalCauses: [], finalAttemptTerminalCauseOmittedCount: 0 },
        }
      },
    })
    await surface({ ...baseInput, mode: "ai_ctrl" })
    expect(observedRef).toBe("resource://test.ctrl")
  })

  it("accepts typed public Ctrl identity from the registered surface", async () => {
    const mode = createRegisteredPropositionModeExecutionPort({
      ordinary: async () => { throw new Error("not used") },
      ai_ctrl: async () => ({
        identity: {
          requestedMode: "ai_ctrl" as const,
          actualMode: "ai_ctrl" as const,
          sessionId: "session-ctrl",
          evidenceSource: "terminal.runtime.public-events/v1" as const,
          workflow: {
            kind: "AICtrlWorkflow" as const,
            definitionRef: "resource://test.ctrl",
            instanceId: "instance-ctrl",
            runId: "run-ctrl",
            nodeActorId: "node-ctrl",
          },
        },
        process: processResult,
        providerTurns: [],
        providerAttempts: { providerCalls: 0, providerFailures: 0, providerRetries: 0, finalAttemptTerminalCauses: [], finalAttemptTerminalCauseOmittedCount: 0 },
      }),
      ai_data: async () => { throw new Error("not used") },
    })
    const result = await mode.execute({ ...baseInput, mode: "ai_ctrl" })
    expect(result.identity.workflow?.kind).toBe("AICtrlWorkflow")
  })

  it("rejects ordinary fallback and internal-store evidence", async () => {
    const mode = createRegisteredPropositionModeExecutionPort({
      ordinary: async () => { throw new Error("not used") },
      ai_ctrl: async () => ({
        identity: {
          requestedMode: "ai_ctrl" as const,
          actualMode: "ordinary" as const,
          sessionId: "session-fallback",
          evidenceSource: "terminal.runtime.public-events/v1" as const,
          workflow: null,
        },
        process: processResult,
        providerTurns: [],
        providerAttempts: { providerCalls: 0, providerFailures: 0, providerRetries: 0, finalAttemptTerminalCauses: [], finalAttemptTerminalCauseOmittedCount: 0 },
      }),
      ai_data: async () => ({
        identity: {
          requestedMode: "ai_data" as const,
          actualMode: "ai_data" as const,
          sessionId: "session-data",
          evidenceSource: "workflow.internal.store",
          workflow: {
            kind: "AIDataWorkflow" as const,
            definitionRef: "resource://test.data",
            instanceId: "instance-data",
            runId: "run-data",
            nodeActorId: "node-data",
          },
        },
        process: processResult,
        providerTurns: [],
        providerAttempts: { providerCalls: 0, providerFailures: 0, providerRetries: 0, finalAttemptTerminalCauses: [], finalAttemptTerminalCauseOmittedCount: 0 },
      }),
    })
    await expect(mode.execute({ ...baseInput, mode: "ai_ctrl" })).rejects.toThrow("mode mismatch")
    await expect(mode.execute({ ...baseInput, mode: "ai_data" })).rejects.toThrow("public runtime events")
  })
})

describe("proposition receipt persistence", () => {
  it("atomically persists a redacted per-cell receipt and rejects credential material", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eidolon-proposition-receipt-"))
    const receipt = {
      schemaVersion: "eidolon.codument-proposition-receipt/v1" as const,
      receiptDigest: `sha256:${"c".repeat(64)}` as const,
      manifestDigest: `sha256:${"a".repeat(64)}` as const,
      corpusDigest: `sha256:${"a".repeat(64)}` as const,
      requestDigest: `sha256:${"b".repeat(64)}` as const,
      verifierDigest: `sha256:${"a".repeat(64)}` as const,
      modeIdentity: {
        requestedMode: "ordinary" as const,
        actualMode: "ordinary" as const,
        sessionId: "session-receipt",
        evidenceSource: "terminal.runtime.public-events/v1" as const,
        workflow: null,
      },
      modeIdentities: [{
        requestedMode: "ordinary" as const,
        actualMode: "ordinary" as const,
        sessionId: "session-receipt",
        evidenceSource: "terminal.runtime.public-events/v1" as const,
        workflow: null,
      }],
      process: processResult,
      verifier: { exitCode: 0, passed: true, outputArtifact: "artifact://verify" },
      providerScope: {
        classification: "short_or_cold" as const,
        providerClass: "official_deepseek" as const,
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        contextEpoch: 1,
        eligibleSubsequentTurns: 0,
        promptTokens: 100,
        cacheHitTokens: 0,
        cacheMissTokens: 100,
        outputTokens: 10,
        normalizedInputCost: 100,
        cacheHitRatio: 0,
        cacheEligiblePrefixTokens: 0,
        cacheEligiblePrefixHitTokens: 0,
        cacheEligiblePrefixHitRatio: null,
        newInputTokens: 0,
        retainedPrefixIntegrity: 1,
      },
      providerScopes: [],
      providerAttempts: {
        providerCalls: 1,
        providerFailures: 0,
        providerRetries: 0,
        finalAttemptTerminalCauses: ["completed"],
        finalAttemptTerminalCauseOmittedCount: 0,
      },
      workspaceArtifact: "artifact://workspace",
      eidolonExecutableDigest: `sha256:${"a".repeat(64)}` as const,
      codumentExecutableDigest: `sha256:${"b".repeat(64)}` as const,
    }
    try {
      const store = createJsonPropositionReceiptStore(root)
      const destination = await store.persist(receipt)
      expect(JSON.parse(await readFile(destination, "utf8")).receiptDigest).toBe(receipt.receiptDigest)
      await expect(store.persist({ ...receipt, workspaceArtifact: "api_key=secret-value" })).rejects.toThrow("credential-like")

      const eidolon = path.join(root, "eidolon")
      const codument = path.join(root, "codument")
      await Promise.all([
        writeFile(eidolon, "eidolon-v1", { mode: 0o700 }),
        writeFile(codument, "codument-v1", { mode: 0o700 }),
      ])
      const epoch = await bindCodumentPropositionExecutableEpoch({
        executionRoot: root,
        runId: "receipt-r1",
        eidolonExecutable: eidolon,
        codumentExecutable: codument,
      })
      const checkedStore = createExecutableEpochReceiptStore(path.join(root, "checked"), epoch)
      await chmod(epoch.codumentExecutable, 0o700)
      await writeFile(epoch.codumentExecutable, "drifted", { mode: 0o500 })
      await expect(checkedStore.persist({
        ...receipt,
        eidolonExecutableDigest: epoch.eidolonExecutableDigest,
        codumentExecutableDigest: epoch.codumentExecutableDigest,
      })).rejects.toThrow("integrity drift")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("production proposition matrix catalog", () => {
  it("accepts compatible iQingwa receipts without borrowing official cost weights", () => {
    const scope = {
      classification: "short_or_cold" as const,
      providerClass: "deepseek_compatible" as const,
      providerId: "deepseek",
      model: iqingwaProvider.credential.model,
      contextEpoch: 0,
      eligibleSubsequentTurns: 0,
      promptTokens: 1_000,
      cacheHitTokens: 0,
      cacheMissTokens: 1_000,
      outputTokens: 10,
      normalizedInputCost: null,
      cacheHitRatio: 0,
      cacheEligiblePrefixTokens: 0,
      cacheEligiblePrefixHitTokens: 0,
      cacheEligiblePrefixHitRatio: null,
      newInputTokens: 0,
      retainedPrefixIntegrity: 1,
    }
    const receipt = {
      process: processResult,
      verifier: { passed: true },
      modeIdentity: { actualMode: "ordinary" },
      modeIdentities: [{ actualMode: "ordinary" }],
      providerScope: scope,
      providerScopes: [scope],
      providerAttempts: {
        providerCalls: 1,
        providerFailures: 0,
        providerRetries: 0,
        finalAttemptTerminalCauses: ["completed"],
        finalAttemptTerminalCauseOmittedCount: 0,
      },
    }
    expect(receiptAccepted(receipt as never, iqingwaProvider)).toBe(true)
    expect(receiptAccepted(receipt as never, officialProvider)).toBe(false)
    expect(() => resolveCodumentPropositionProviderBinding("arbitrary-gateway")).toThrow("unsupported")
  })

  it("accepts unbilled pre-accept observations by facts rather than retry-count equality", () => {
    const unbilledPreaccept = {
      classification: "incomplete_usage" as const,
      providerClass: "deepseek_compatible" as const,
      providerId: "deepseek",
      model: iqingwaProvider.credential.model,
      contextEpoch: 1,
      eligibleSubsequentTurns: 0,
      promptTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      outputTokens: 0,
      normalizedInputCost: null,
      cacheHitRatio: null,
      cacheEligiblePrefixTokens: 0,
      cacheEligiblePrefixHitTokens: 0,
      cacheEligiblePrefixHitRatio: null,
      newInputTokens: 0,
      retainedPrefixIntegrity: 1,
    }
    const comparable = {
      ...unbilledPreaccept,
      classification: "comparable_long_context" as const,
      eligibleSubsequentTurns: 3,
      promptTokens: 100_000,
      cacheHitTokens: 99_500,
      cacheMissTokens: 500,
      outputTokens: 1_000,
      cacheHitRatio: 0.995,
      cacheEligiblePrefixTokens: 90_000,
      cacheEligiblePrefixHitTokens: 89_900,
      cacheEligiblePrefixHitRatio: 89_900 / 90_000,
      newInputTokens: 10_000,
    }
    const receipt = {
      process: processResult,
      verifier: { passed: true },
      modeIdentity: { actualMode: "ordinary" },
      modeIdentities: [{ actualMode: "ordinary" }],
      providerScope: { ...comparable, contextEpoch: null, classification: "incomplete_usage" as const },
      providerScopes: [
        unbilledPreaccept,
        { ...unbilledPreaccept, contextEpoch: 2 },
        { ...unbilledPreaccept, contextEpoch: 3 },
        comparable,
      ],
      providerAttempts: {
        providerCalls: 1,
        providerFailures: 0,
        providerRetries: 0,
        finalAttemptTerminalCauses: ["completed"],
        finalAttemptTerminalCauseOmittedCount: 0,
      },
    }
    expect(receiptAccepted(receipt as never, iqingwaProvider)).toBe(true)
    expect(receiptAccepted({
      ...receipt,
      providerScopes: [{ ...unbilledPreaccept, outputTokens: 1 }, comparable],
    } as never, iqingwaProvider)).toBe(false)
  })

  it("pins the first executable epoch across source replacement and run resume", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eidolon-proposition-epoch-"))
    const eidolon = path.join(root, "eidolon")
    const codument = path.join(root, "codument")
    const sidecar = path.join(root, "node_modules", "@opentui", "core-test", "native.bin")
    await mkdir(path.dirname(sidecar), { recursive: true })
    await Promise.all([
      writeFile(eidolon, "eidolon-v1", { mode: 0o700 }),
      writeFile(codument, "codument-v1", { mode: 0o700 }),
      writeFile(sidecar, "sidecar-v1", { mode: 0o600 }),
    ])
    try {
      const first = await bindCodumentPropositionExecutableEpoch({
        executionRoot: root,
        runId: "matrix-r1",
        eidolonExecutable: eidolon,
        codumentExecutable: codument,
      })
      await Promise.all([
        writeFile(eidolon, "eidolon-v2", { mode: 0o700 }),
        writeFile(codument, "codument-v2", { mode: 0o700 }),
        writeFile(sidecar, "sidecar-v2", { mode: 0o600 }),
      ])
      const resumed = await bindCodumentPropositionExecutableEpoch({
        executionRoot: root,
        runId: "matrix-r1",
        eidolonExecutable: eidolon,
        codumentExecutable: codument,
      })
      const nextRun = await bindCodumentPropositionExecutableEpoch({
        executionRoot: root,
        runId: "matrix-r2",
        eidolonExecutable: eidolon,
        codumentExecutable: codument,
      })

      expect(resumed).toEqual(first)
      expect(await readFile(first.eidolonExecutable, "utf8")).toBe("eidolon-v1")
      expect(await readFile(first.codumentExecutable, "utf8")).toBe("codument-v1")
      expect(await readFile(path.join(path.dirname(first.eidolonExecutable), "node_modules", "@opentui", "core-test", "native.bin"), "utf8"))
        .toBe("sidecar-v1")
      expect(nextRun.eidolonExecutableDigest).not.toBe(first.eidolonExecutableDigest)
      expect(nextRun.codumentExecutableDigest).not.toBe(first.codumentExecutableDigest)
      expect(nextRun.eidolonRuntimeClosureDigest).not.toBe(first.eidolonRuntimeClosureDigest)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects unsafe run ids and executable epoch integrity drift", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eidolon-proposition-epoch-"))
    const eidolon = path.join(root, "eidolon")
    const codument = path.join(root, "codument")
    await Promise.all([
      writeFile(eidolon, "eidolon-v1", { mode: 0o700 }),
      writeFile(codument, "codument-v1", { mode: 0o700 }),
    ])
    try {
      await expect(bindCodumentPropositionExecutableEpoch({
        executionRoot: root,
        runId: "../escape",
        eidolonExecutable: eidolon,
        codumentExecutable: codument,
      })).rejects.toThrow("safe path segment")
      const epoch = await bindCodumentPropositionExecutableEpoch({
        executionRoot: root,
        runId: "matrix-r1",
        eidolonExecutable: eidolon,
        codumentExecutable: codument,
      })
      await chmod(epoch.eidolonExecutable, 0o700)
      await writeFile(epoch.eidolonExecutable, "tampered", { mode: 0o500 })
      await expect(assertCodumentPropositionExecutableEpoch(epoch)).rejects.toThrow("integrity drift")
      await expect(bindCodumentPropositionExecutableEpoch({
        executionRoot: root,
        runId: "matrix-r1",
        eidolonExecutable: eidolon,
        codumentExecutable: codument,
      })).rejects.toThrow("integrity drift")

      const inconsistent = await bindCodumentPropositionExecutableEpoch({
        executionRoot: root,
        runId: "matrix-inconsistent",
        eidolonExecutable: eidolon,
        codumentExecutable: codument,
      })
      await writeFile(inconsistent.bindingManifest, "{}\n", { mode: 0o600 })
      await expect(bindCodumentPropositionExecutableEpoch({
        executionRoot: root,
        runId: "matrix-inconsistent",
        eidolonExecutable: eidolon,
        codumentExecutable: codument,
      })).rejects.toThrow("invalid proposition executable epoch binding")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("prepares one pinned epoch for a live matrix and none for a deterministic plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eidolon-proposition-matrix-epoch-"))
    const eidolon = path.join(root, "eidolon")
    const codument = path.join(root, "codument")
    await Promise.all([
      writeFile(eidolon, "eidolon-v1", { mode: 0o700 }),
      writeFile(codument, "codument-v1", { mode: 0o700 }),
    ])
    try {
      expect(await prepareLiveMatrixExecutableEpoch({
        selection: { kind: "deterministic" },
        executionRoot: root,
        runId: "deterministic-r1",
      })).toBeNull()
      const epoch = await prepareLiveMatrixExecutableEpoch({
        selection: { kind: "cell", scenarioId: "scenario", mode: "ordinary" },
        executionRoot: root,
        runId: "live-r1",
        eidolonExecutable: eidolon,
        codumentExecutable: codument,
      })
      expect(epoch).not.toBeNull()
      expect(epoch?.eidolonExecutable).toContain(`${path.sep}.executable-snapshots${path.sep}live-r1${path.sep}`)
      expect(epoch?.codumentExecutable).toContain(`${path.sep}.executable-snapshots${path.sep}live-r1${path.sep}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects receipts whose provider scopes predate prefix and new-input evidence", () => {
    const legacyScope = {
      classification: "stable" as const,
      providerClass: "official_deepseek" as const,
      providerId: "deepseek",
      model: "deepseek-v4-flash",
      contextEpoch: 1,
      eligibleSubsequentTurns: 1,
      promptTokens: 200,
      cacheHitTokens: 100,
      cacheMissTokens: 100,
      outputTokens: 10,
      normalizedInputCost: 120,
      cacheHitRatio: 0.5,
      retainedPrefixIntegrity: 1,
    }
    expect(providerScopeEvidenceComplete(legacyScope as never)).toBe(false)
    expect(providerScopeEvidenceComplete({
      ...legacyScope,
      cacheEligiblePrefixTokens: 100,
      cacheEligiblePrefixHitTokens: 100,
      cacheEligiblePrefixHitRatio: 1,
      newInputTokens: 100,
    })).toBe(true)
  })

  it("wires every frozen Codument journey into the full three-mode plan", async () => {
    const sourceRoot = "/tmp/frozen-codument-corpus"
    const scenarios = scenarioCatalog(sourceRoot, 7_200)
    expect(scenarios.map((scenario) => scenario.scenarioId).sort()).toEqual([
      "modeling-blog",
      "modeling-ecommerce-core",
      "modeling-ecommerce-payment",
      "modeling-todo",
      "nested-mission-agent",
      "stream-pipeline-ai-agent",
    ])
    expect(scenarios.find((scenario) => scenario.scenarioId === "modeling-todo")?.expectedAgentInvocations).toBe(2)
    const digest = `sha256:${"a".repeat(64)}` as const
    const manifests = scenarios.map((scenario) => ({
      schemaVersion: "eidolon.codument-proposition-manifest/v1" as const,
      scenarioId: scenario.scenarioId,
      revision: scenario.revision,
      corpusDigest: scenario.corpusDigest,
      sources: [
        { relativePath: scenario.requestRelativePaths[0]!, digest, role: "request" as const },
        { relativePath: scenario.verifierRelativePath, digest, role: "verifier" as const },
      ],
      requestComposition: [scenario.requestRelativePaths[0]!],
      verifier: { argv: [scenario.verifierRelativePath], digest },
      workspaceSeed: "empty_git" as const,
      timeoutSeconds: scenario.timeoutSeconds,
      allowedModes: ["ordinary", "ai_ctrl", "ai_data"] as const,
    }))
    const plan = planCodumentPropositionMatrix({
      manifests,
      selection: { kind: "full" },
      liveEvidence: "official",
      sentinelScenarioIds: ["stream-pipeline-ai-agent"],
    })
    expect(plan.cells).toHaveLength(18)
  })
})
