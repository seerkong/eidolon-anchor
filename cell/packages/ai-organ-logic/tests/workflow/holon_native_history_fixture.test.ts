import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { parseHolonEffectiveSnapshotBytes, parseHolonEffectiveSnapshotIssuanceReceiptBytes } from "holarchy-core-contract"
import { HolarchyFileXnlCapsule } from "holarchy-file-xnl-capsule"
import { FILE_XNL_HOLON_E2E_SCENARIO } from "./fileXnlHolonE2eScenario"
import { productOrganizationFixture } from "./fixtures/holonRepairResourceProductPackage"

const historicalRoot = path.resolve(import.meta.dir, "../resources/holon-task-e2e")
const expectedHistoricalDigests: Record<string, string> = {
  "README.md": "3cb667b6668f2f012e1bac79d1298b7073b1ab116dd9a68f3ff3d33e670e8f93",
  "authority/head.xnl": "2d3d9b0d9947fc5b443cd57f913f0de2189e61c33b3c5e880b73d0f045497152",
  "authority/receipts/000000000001.xnl": "864001283fca3bf108cb0667956b5cf7c7d0bd954a36a285f8bf42892271e544",
  "authority/records/sha256:01f6c662d40f5fe6fd65d353a466e0c40f1521a7848bb8e48cbbf2727cd9d8e7.xnl": "01f6c662d40f5fe6fd65d353a466e0c40f1521a7848bb8e48cbbf2727cd9d8e7",
  "authority/records/sha256:0530ac63e30bf53edc165faef53a1060593a788c0aff5805111e2c064558d06e.xnl": "0530ac63e30bf53edc165faef53a1060593a788c0aff5805111e2c064558d06e",
  "authority/records/sha256:3b156f5be9444c7fb6df5a6f7cc469a7759e0da428b6eb092d76dc800b367eb9.xnl": "3b156f5be9444c7fb6df5a6f7cc469a7759e0da428b6eb092d76dc800b367eb9",
  "authority/records/sha256:697b02d8eb2dca3d77ed5fa7835e68f858d0a1c7a0018893684fc5031abaf0b4.xnl": "697b02d8eb2dca3d77ed5fa7835e68f858d0a1c7a0018893684fc5031abaf0b4",
  "authority/records/sha256:6ed48dec92ad427bb5e1886ad837a5a2fc10d32bbeb3f2732bfdc04f7f85fc2d.xnl": "6ed48dec92ad427bb5e1886ad837a5a2fc10d32bbeb3f2732bfdc04f7f85fc2d",
  "authority/records/sha256:6f131eb885b2ca617b8177089431bef57b34e32dfd26227e2a6c7c018de4e1b9.xnl": "6f131eb885b2ca617b8177089431bef57b34e32dfd26227e2a6c7c018de4e1b9",
  "authority/records/sha256:8cffce6980678e415a84d81b397b43683d794a615bc8904904212d80cfec286c.xnl": "8cffce6980678e415a84d81b397b43683d794a615bc8904904212d80cfec286c",
  "authority/records/sha256:93e9d32281a96e4e1720fc071265dbbc0c8df9e74c63bacadccb9029f3f869a9.xnl": "93e9d32281a96e4e1720fc071265dbbc0c8df9e74c63bacadccb9029f3f869a9",
  "authority/records/sha256:a9c42fd82e27b22b13043a58bc9a4bcfb00f49c62d49d17feca58049c132301b.xnl": "a9c42fd82e27b22b13043a58bc9a4bcfb00f49c62d49d17feca58049c132301b",
  "authority/records/sha256:bd7feb1dc119167da491e2c5b146600e76c3f46009581d5b07d7d095abc5766a.xnl": "bd7feb1dc119167da491e2c5b146600e76c3f46009581d5b07d7d095abc5766a",
  "authority/records/sha256:da7a3de45b88c1b2c2597e112f4d7dafea6d66ee559cbcd96536305db4d6be34.xnl": "da7a3de45b88c1b2c2597e112f4d7dafea6d66ee559cbcd96536305db4d6be34",
  "authority/records/sha256:f86ba8bcc599b66b6e15e52b48a58cadd14379384be8d91fd4687ee2c451ec0a.xnl": "f86ba8bcc599b66b6e15e52b48a58cadd14379384be8d91fd4687ee2c451ec0a",
  "authority/trees/sha256:50031d5dc3e27f9ce578e1954831b7c9db40f211ce16acbf299d346f30965a26.xnl": "50031d5dc3e27f9ce578e1954831b7c9db40f211ce16acbf299d346f30965a26",
  "issued/holon-effective-snapshot.json": "f090b57fe189e257a7c2a40ad5cd6fc89e688004134aa2e9386d5d2a5df4c07e",
  "issued/issuance-receipt.json": "7a3440488ded03bab5cecde43c40171cf334e53a32ee7779b19cee3b88bad700",
  "manifest.json": "86db68f54e0f93f7a2fbfcc6387328bf7a26ef3fe020341596875fb1b20cabb7"
}

describe("native organization fixtures and retained historical proofs", () => {
  it("retains every historical record, tree, receipt and issued byte", async () => {
    for (const [name, digest] of Object.entries(expectedHistoricalDigests)) {
      expect(createHash("sha256").update(await readFile(path.join(historicalRoot, name))).digest("hex")).toBe(digest)
    }
    const snapshot = await parseHolonEffectiveSnapshotBytes(await readFile(path.join(historicalRoot, "issued/holon-effective-snapshot.json")))
    const receipt = await readFile(path.join(historicalRoot, "issued/issuance-receipt.json"))
    expect(parseHolonEffectiveSnapshotIssuanceReceiptBytes(receipt, snapshot).sourceRevision).toBe("1")
    const tampered = Buffer.from(receipt)
    tampered[tampered.length - 2] = 120
    expect(() => parseHolonEffectiveSnapshotIssuanceReceiptBytes(tampered, snapshot)).toThrow()
  })

  it("reopens v1 without rewriting and fails closed on a damaged historical record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "holon-history-"))
    try {
      await cp(path.join(historicalRoot, "authority"), root, { recursive: true })
      const capsule = new HolarchyFileXnlCapsule({ root, authorityId: "holarchy-file-xnl-fixture" })
      expect((await capsule.start()).revision).toBe(1)
      for (const [name, digest] of Object.entries(expectedHistoricalDigests).filter(([name]) => name.startsWith("authority/"))) {
        expect(createHash("sha256").update(await readFile(path.join(root, name.slice(10)))).digest("hex")).toBe(digest)
      }
      const record = Object.keys(expectedHistoricalDigests).find(name => name.startsWith("authority/records/"))!
      await writeFile(path.join(root, record.slice(10)), "corrupted")
      await expect(new HolarchyFileXnlCapsule({ root, authorityId: "holarchy-file-xnl-fixture" }).start()).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("assembles native arrays through public fixtures and has no local table/string wrapper builders", async () => {
    for (const fixture of [FILE_XNL_HOLON_E2E_SCENARIO.fixture, productOrganizationFixture()]) {
      const role = fixture.state.entities.find(entity => entity.kind === "Role")!
      expect(role.kind).toBe("Role")
      if (role.kind === "Role") { expect(Array.isArray(role.domains)).toBe(true); expect(Array.isArray(role.policies)).toBe(true) }
      expect(JSON.stringify(fixture)).not.toMatch(/domainsJson|accountabilitiesJson|policiesJson|capabilityRequirementsJson/)
    }
    for (const name of ["fileXnlHolonE2eScenario.ts", "fixtures/holonRepairResourceProductPackage.ts", "holon_execution_binding_registry.test.ts"]) {
      const source = await readFile(path.join(import.meta.dir, name), "utf8")
      expect(source).toContain("createSyntheticTeamFixture")
      expect(source).not.toMatch(/domainsJson:|accountabilitiesJson:|policiesJson:|capabilityRequirementsJson:/)
    }
  })
})
