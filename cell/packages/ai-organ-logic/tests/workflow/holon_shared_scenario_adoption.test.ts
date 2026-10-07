import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createInferenceCapsule } from "depa-inference-capsule"
import { canonicalHolonEffectiveSnapshotIssuanceReceiptBytes, type OrganizationChangeSet } from "holarchy-core-contract"
import { HolonAuthorityContractError, diffOrganizationStates, reconcileOrganization } from "holarchy-core-logic"
import { HolarchyFileXnlCapsule } from "holarchy-file-xnl-capsule"
import { createFixtureSeedChangeSet, decodeOrganizationScenario, organizationScenarioCatalog, runOrganizationScenario } from "holarchy-test-support"
import { installedHolarchyIssuerVersion } from "./fileXnlHolonIssuerFixture"
import { createHolonRepairResourceProductFixture } from "./fixtures/holonRepairResourceProductRuntime"
import { EidolonAppResourceRegistryAdapter } from "../../src/resources"
import { canonicalHolonTaskRuntimeDefinitionBytes } from "../../src/organization/HolonTaskRuntimeContract"
import { productOrganizationResource } from "./fixtures/holonRepairResourceProductPackage"

async function inventory(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  async function visit(dir: string) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, item.name)
      if (item.isDirectory()) await visit(target)
      else result[path.relative(root, target)] = createHash("sha256").update(await readFile(target)).digest("hex")
    }
  }
  await visit(root)
  return result
}

for (const id of ["atomic-transfer", "same-field-conflict", "retired-target-independent-rename"]) {
  test(`shared E scenario ${id} adopts actual issued bytes and retains frozen tasks`, async () => {
    const scenario = decodeOrganizationScenario(organizationScenarioCatalog().find(item => item.id === id)!)
    const root = await mkdtemp(path.join(os.tmpdir(), "holon-shared-e-"))
    const authorityRoot = path.join(root, "authority")
    const issuerVersion = await installedHolarchyIssuerVersion()
    const capsule = new HolarchyFileXnlCapsule({ root: authorityRoot, authorityId: scenario.base.authorityId, observedAt: () => "2026-01-01T00:00:30.000Z", authorization: { resolveScope: async () => ({ kind: "all" }) } })
    let execution = 0
    const config = () => ({ actorRef: "scenario-owner", executionId: `scenario-${++execution}`, executionInstant: "2026-01-01T00:00:10.000Z" })
    const commit = (input: OrganizationChangeSet) => capsule.commitOrganizationChangeSet(input, config())
    await commit(createFixtureSeedChangeSet(scenario.base))
    let rootHolonRef = id === "atomic-transfer" ? "team-a" : "other-root"
    const memberRef = id === "atomic-transfer" ? "lin" : "noa"
    async function issue() {
      // A distinct capsule must reconstruct the current owner before issuance.
      const fresh = new HolarchyFileXnlCapsule({ root: authorityRoot, authorityId: scenario.base.authorityId, observedAt: () => "2026-01-01T00:00:30.000Z" })
      await fresh.start()
      const issued = await fresh.projectOrganizationSnapshot({ rootHolonRef, effectiveAt: "2026-01-01T00:00:00.000Z" }, { maxDepth: 10, maxRecords: 200 })
      return { snapshotBytes: issued.canonicalBytes, issuanceReceiptBytes: canonicalHolonEffectiveSnapshotIssuanceReceiptBytes(issued.issuanceReceipt, issued.snapshot),
        provenance: { issuerPackage: "holarchy-file-xnl-capsule" as const, issuerPackageVersion: issuerVersion, ...issued.issuanceReceipt } }
    }
    const firstIssue = await issue()
    const fixture = await createHolonRepairResourceProductFixture({ organization: { issuer: firstIssue, rootHolonRef, memberRef, requiredRoleRefs: [] } })
    let nextFixture: typeof fixture | undefined
    const hosts: Awaited<ReturnType<typeof fixture.openStandalone>>[] = []
    async function dispatch(host: typeof hosts[number], requestId: string, executionFixture = fixture) {
      const accepted = await host.capability.service.assign({ kind: "admission", admissionId: host.admissionIds[0]! }, {
        kind: "holon-task-runtime-invocation", schemaVersion: "eidolon.holon-task-runtime-invocation/v1", requestId, idempotencyKey: requestId, replyMode: "none", occurredAt: "2026-01-01T00:00:40.000Z",
        origin: { kind: "product", surface: "HolonAssign", requestRef: `request:${requestId}` }, taskRequest: { kind: "derive", name: "Verify shared organization adoption" }, input: fixture.input,
      }, { leaseDurationMs: 5_000, maxSteps: 16 })
      const selector = { admissionId: host.admissionIds[0]!, taskSpaceId: accepted.task.taskSpaceId, taskId: accepted.task.taskId }
      for (let i = 0; i < 500; i++) {
        const observed = await host.capability.service.observe(selector)
        if (["Succeeded", "Failed", "Cancelled"].includes(observed.status)) {
          expect(observed.status, JSON.stringify(observed)).toBe("Succeeded")
          expect((await executionFixture.verify(executionFixture.effects.at(-1)!.value)).passed).toBe(true)
          return { accepted, selector, observed }
        }
        await Bun.sleep(10)
      }
      throw new Error(`Shared scenario task did not settle: ${JSON.stringify({ requestId, observed: await host.capability.service.observe(selector), failures: executionFixture.transport.failures.map(String) })}`)
    }
    try {
      const oldHost = await fixture.openStandalone(); hosts.push(oldHost)
      const oldTask = await dispatch(oldHost, `${id}-before`)
      const oldReceiptBytes = JSON.stringify(oldTask.accepted.task.snapshotReceipt)
      if (scenario.remote.revision !== scenario.base.revision) await commit(diffOrganizationStates(scenario.base, { ...scenario.remote, revision: scenario.base.revision }, "remote-update"))
      const inference = createInferenceCapsule()
      const evidence = await runOrganizationScenario({ host: "E", runtimeVersion: `bun-${Bun.version}`, packageVersions: { "holarchy-file-xnl-capsule": issuerVersion },
        load: () => capsule.loadOrganizationState({ authorityId: scenario.base.authorityId, effectiveDate: scenario.base.effectiveDate }), commit,
        preview: async group => (await capsule.previewOrganizationChangeSet(group, config())).after,
        observeAuthority: async () => { const state = await capsule.store.load(); return { revision: state.revision, sequence: state.sequence, tables: state.tables, files: await inventory(authorityRoot) } },
        reconcile: input => reconcileOrganization({ infer: async request => { const result = await inference.infer(request); if (result.status !== "complete") console.error(JSON.stringify({ scenario: id, inferenceStatus: result.status, diagnostics: result.diagnostics })); return result }, validateCandidate: async ({ changeSet }) => {
          try { await capsule.previewOrganizationChangeSet(changeSet, config()); return [] }
          catch (error) { if (error instanceof HolonAuthorityContractError && error.diagnostics.length) return error.diagnostics; throw error }
        } }, input),
      }, scenario)
      expect(evidence.assertions.filter(item => item.status !== "PASS")).toEqual([])
      expect(evidence.status).toBe("PASS")
      expect(evidence.fixtureDigest).toMatch(/^sha256:/)
      expect(evidence.entryPoints).toContain("load final authority")
      if (id !== "atomic-transfer") expect(evidence.entryPoints).toContain("createReconciledChangeSet")
      if (id === "atomic-transfer") {
        const snapshot = await new EidolonAppResourceRegistryAdapter({ layers: [{ id: "workspace", rootDir: fixture.resources }] }).snapshot()
        const definition = { ...snapshot.holonTaskRuntimeDefinitions[0]!.admission.definition, rootHolonRef: "team-b" }
        const bytes = canonicalHolonTaskRuntimeDefinitionBytes(definition)
        await writeFile(path.join(fixture.resources, "taskRuntimes/Product.xnl"), `<HolonTaskRuntimeDefinition #eidolon.product.Runtime envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {definitionBytesBase64="${Buffer.from(bytes).toString("base64")}"}>`)
        for (const name of ["ctrl/Product.xnl", "productData/Product.xnl"]) {
          const file = path.join(fixture.resources, name)
          await writeFile(file, (await readFile(file, "utf8")).replaceAll('"team-a"', '"team-b"'))
        }
        rootHolonRef = "team-b"
      }
      const currentIssue = await issue()
      await writeFile(path.join(fixture.resources, "organizations/Product.xnl"), productOrganizationResource(currentIssue))
      nextFixture = await createHolonRepairResourceProductFixture({ root: fixture.root, existing: true })
      const currentHost = await nextFixture.openStandalone(); hosts.push(currentHost)
      expect(currentHost.admissionIds[0]).not.toBe(oldHost.admissionIds[0])
      const currentTask = await dispatch(currentHost, `${id}-after`, nextFixture)
      expect(currentTask.accepted.task.snapshotReceipt.holonSnapshotDigest).not.toBe(oldTask.accepted.task.snapshotReceipt.holonSnapshotDigest)
      expect(JSON.stringify(oldTask.accepted.task.snapshotReceipt)).toBe(oldReceiptBytes)
      expect(await oldHost.capability.service.observe(oldTask.selector)).toEqual(oldTask.observed)
      expect([...fixture.effects, ...nextFixture.effects].filter(effect => effect.accepted)).toHaveLength(2)
      expect(currentTask.accepted.task.snapshotReceipt.eligibleMemberRefs).toContain(memberRef)
      if (id === "atomic-transfer") {
        expect(currentTask.accepted.task.snapshotReceipt.eligibleRoleRefs).toContain("review-b")
        expect(oldTask.accepted.task.snapshotReceipt.eligibleRoleRefs).toContain("review-a")
      }
      // Original issuance remains independently consumable after the successor is adopted.
      expect(firstIssue.provenance.sourceRevision).toBe("1")
      expect(currentIssue.provenance.sourceRevision).toBe(String(scenario.documents.expected.commitRevision))
      if (process.env.EIDOLON_HOLON_SCENARIO_REPORT_DIR) {
        const reports = path.resolve(process.env.EIDOLON_HOLON_SCENARIO_REPORT_DIR)
        await mkdir(reports, { recursive: true })
        await writeFile(path.join(reports, `${id}.json`), JSON.stringify({ ...evidence,
          entryPoints: [...evidence.entryPoints, "projectOrganizationSnapshot", "EidolonAppResourceRegistryAdapter.snapshot", "openLocalHolonTaskRuntime", "TaskRuntimeService.assign", "TaskRuntimeService.observe", "verifyProductArtifact"],
          adoption: { old: oldTask.accepted.task.snapshotReceipt, current: currentTask.accepted.task.snapshotReceipt, oldTaskStable: true, artifactVerified: true },
        }, null, 2))
      }
    } finally {
      for (const host of hosts) host.close()
      await fixture.transport.close()
      await nextFixture?.transport.close()
      await rm(fixture.root, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  }, 65_000)
}
