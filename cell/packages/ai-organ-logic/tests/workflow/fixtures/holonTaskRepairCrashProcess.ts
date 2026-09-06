import { openHost } from "./holonTaskFileRuntime"
import { repairHolonTask } from "../../../src/organization/HolonTaskInspection"

const [root, selectorJson, requestJson] = process.argv.slice(2)
const selector = JSON.parse(selectorJson!)
const request = JSON.parse(requestJson!)
const host = await openHost({ root: root!, actorDispatch: { async dispatch() { throw new Error("must not dispatch before subscription publication") } } })
await repairHolonTask({
  owner: host.support.taskManager.owner,
  journal: {
    ...host.support.journal,
    // replan has returned: snapshot + receipt + repair artifact are owner-admitted.
    async subscribe() { process.exit(74) },
  },
  now: Date.now, wakeErrors: new Map(),
  resolveTarget: () => host.admission,
  prepareSuccessor: (admission, source) => {
    const { schemaVersion, subscriptionId, inputDigest, ...subscription } = source
    const authority = admission.snapshotAuthority
    return { subscription, snapshotReceipt: {
      kind: "holon-task-snapshot-receipt", schemaVersion: "eidolon.holon-task-snapshot-receipt/v1",
      taskSpaceId: source.taskSpaceId, holonRef: authority.holonRef, effectiveAt: authority.effectiveAt,
      holonSnapshotRef: authority.holonSnapshotRef, holonSnapshotDigest: authority.holonSnapshotDigest,
      snapshotArtifactDigest: authority.snapshotArtifactDigest, issuerReceiptId: source.snapshotReceiptId as `sha256:${string}`,
      issuerReceiptArtifactDigest: source.snapshotReceiptId as `sha256:${string}`,
      executionBindingRef: authority.executionBindingRef, executionBindingDigest: authority.executionBindingDigest,
      eligibleMemberRefs: authority.eligibleMemberRefs, eligibleRoleRefs: authority.eligibleRoleRefs,
    } }
  },
  async wake() { throw new Error("must exit before wake") },
}, { selector, invocation: request })
throw new Error("Crash hook did not execute")
