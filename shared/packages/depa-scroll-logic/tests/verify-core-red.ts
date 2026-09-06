import { AssertionError } from "node:assert";
import assert from "node:assert/strict";
import { coreCases } from "./core-cases.ts";

// Deliberate behavioral failures, frozen before production implementation.
const expectedRed = [
  "V03-earlier-bounded-exhausted", "V04-forward-opaque-boundary", "V05-new-intent-during-prepend",
  "V05-source-switch-invalidates-work", "V06-measured-follow-outer-height",
  "V06-width-invalidates-preserves-anchor", "V06-revision-invalidates-height",
  "V06-desired-window-precedes-scroll", "V07-live-browse-is-bounded",
  "V07-end-refreshes-and-deduplicates", "V08-stale-End-cached-tail", "V08-stale-End-evicted-tail",
  "V09-error-timeout", "V09-error-rejected", "V09-error-budget", "V09-no-progress-empty-page",
  "V09-cancel-unblocks-request", "V05-replacement-rejects-old-page",
  "V05-obsolete-correction-is-revoked", "V06-native-geometry-updates-window",
];
const expectedGreen = ["sourceId", "actorId", "sourceEpoch", "generation", "snapshot", "requestId", "windowRevision"].map(field => `guard-obsolete-${field}`);
const failed: string[] = [];
const passed: string[] = [];
for (const scenario of coreCases) {
  try {
    scenario.run();
    passed.push(scenario.id);
  } catch (error) {
    if (!(error instanceof AssertionError) || !error.message.includes(`behavior:${scenario.id}`)) throw error;
    failed.push(scenario.id);
  }
}
assert.deepStrictEqual(failed, expectedRed, "RED gate requires the exact deliberate assertion failures");
assert.deepStrictEqual(passed, expectedGreen, "RED gate requires the exact existing rejection guards");
console.log(JSON.stringify({ result: "RED_CONFIRMED", behavioralFailures: failed, passingGuards: passed }, null, 2));
