import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_BYTES, HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_FQN } from "holarchy-core-contract"
import { sha256Digest } from "halfcode-compiler.xnl/resource-core"
import { canonicalHolonExecutionBindingBytes, HOLON_EXECUTION_BINDING_KIND_DEFINITION_BYTES, HOLON_EXECUTION_BINDING_KIND_DEFINITION_FQN, projectHolonExecutionBindings } from "../src/index"

for (const directory of ["holon-task-e2e", "holon-task-native-e2e"]) {
  test(`public binding adapter consumes exact ${directory} issuance and rejects tampered proof`, async () => {
    const root = path.resolve(import.meta.dir, `../../ai-organ-logic/tests/resources/${directory}/issued`)
    const snapshotBytes = await readFile(path.join(root, "holon-effective-snapshot.json"))
    const receiptBytes = await readFile(path.join(root, "issuance-receipt.json"))
    const policy = { version: "1", runtime: { mode: "isolated-task-runtime" }, taskProfileRef: "resource://fixture.profile", capabilityRefs: [], toolRefs: [], materialRefs: [] }
    const adapters = [
      { kind: "ai-agent", agentDefinitionRef: "resource://fixture.agent", runtimeProfileRef: "resource://fixture.profile" },
      { kind: "human-endpoint", humanEndpointRef: "resource://fixture.endpoint", inboxProfileRef: "resource://fixture.profile" },
      { kind: "service", serviceAdapterRef: "resource://fixture.service", runtimeProfileRef: "resource://fixture.profile" },
      { kind: "hybrid", policyRef: "resource://fixture.profile", candidateBindingRefs: ["resource://fixture.binding0", "resource://fixture.binding1"] },
    ]
    const record = (resourceId: string, kind: string, properties: Record<string, string> = {}) => ({ resourceId, kind, node: { properties } })
    const snapshot = record("fixture.snapshot", "HolonEffectiveSnapshot", { snapshotBytesBase64: snapshotBytes.toString("base64"), issuanceReceiptBytesBase64: receiptBytes.toString("base64") })
    const bindings = adapters.map((adapter, index) => record(`fixture.binding${index}`, "HolonExecutionBinding", { bindingBytesBase64: Buffer.from(canonicalHolonExecutionBindingBytes({
      apiVersion: "eidolon.ai/v1", kind: "HolonExecutionBinding", bindingRef: `resource://fixture.binding${index}`, snapshotRef: "resource://fixture.snapshot", target: { kind: "member", memberRef: "member-reviewer" }, adapter, policy,
    })).toString("base64") }))
    const resources = [snapshot, ...bindings, record("fixture.profile", "ContextMaterial"), record("fixture.agent", "AIAgentDefinition"), record("fixture.endpoint", "ContextMaterial"), record("fixture.service", "ContextMaterial")]
    // Explicit registry effect port isolates adapter validation from the FS compiler.
    const input = { registry: { byKind: new Map([["HolonExecutionBinding", bindings]]), byId: new Map(resources.map(resource => [resource.resourceId, { resource }])), kindDefinitions: new Map([
      ["HolonEffectiveSnapshot", { definition: { resourceId: HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_FQN } }],
      ["HolonExecutionBinding", { definition: { resourceId: HOLON_EXECUTION_BINDING_KIND_DEFINITION_FQN } }],
    ]) }, contentIdentities: new Map(resources.map(resource => [resource.resourceId, { resourceId: resource.resourceId, contentDigest: sha256Digest(Buffer.from(JSON.stringify(resource))) }])),
      kindDefinitionAuthorityDigests: new Map([["HolonEffectiveSnapshot", sha256Digest(HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_BYTES)], ["HolonExecutionBinding", sha256Digest(HOLON_EXECUTION_BINDING_KIND_DEFINITION_BYTES)]]), registryRevision: "fixture-registry" }
    const projections = await projectHolonExecutionBindings(input as any)
    expect(projections.map(p => p.binding.adapter.kind)).toEqual(["ai-agent", "human-endpoint", "service", "hybrid"])
    for (const projection of projections) {
      expect(projection.receipt.sourceRevision).toBe("1")
      expect(projection.receiptBytesDigest).toBe(sha256Digest(receiptBytes))
      expect(projection.snapshot.records.some(record => record.kind === "Member" && record.id === "member-reviewer")).toBe(true)
    }
    const damaged = Buffer.from(receiptBytes); damaged[damaged.length - 2] = 120
    snapshot.node.properties.issuanceReceiptBytesBase64 = damaged.toString("base64")
    await expect(projectHolonExecutionBindings(input as any)).rejects.toThrow()
  })
}
