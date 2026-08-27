import { describe, expect, it } from "bun:test";

import {
  ProviderContextEpochError,
  createProviderContextCompactionProof,
  createProviderEpochReceiptV2,
  createProviderRequestAdmissionReceipt,
  importLegacyProviderContextAuthority,
} from "@cell/ai-organ-logic/conversation/ProviderContextEpochV2";
import { computeProviderEpochReceiptIntegrityDigest } from "@cell/ai-organ-logic/conversation/ProviderEpochProjection";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

function epochInput() {
  return {
    sessionId: "session-1",
    actorKey: "actor-key-1",
    actorId: "actor-id-1",
    epoch: 2,
    previousReceiptDigest: digest("1"),
    targetProviderId: "deepseek",
    targetModelId: "deepseek-chat",
    targetProfileId: "deepseek-official-chat@1" as const,
    baselineHeads: {
      historyHeadGenerationId: "history-2",
      promptHeadGenerationId: "prompt-1",
      factHeadDigest: digest("2"),
    },
    sourceHistoryMessageCount: 0,
    sourceFrontierDigest: digest("3"),
    pendingDeliveryDigest: digest("4"),
    handoffDigest: digest("5"),
    frozenResourceDigest: digest("6"),
    providerSurfaceDigest: digest("7"),
    retentionPolicy: { maxRevisionsPerNamespace: 32, maxCanonicalFactBytesPerEpoch: 65_536 },
    reason: "history_compaction" as const,
    compactionProofDigest: digest("8"),
    createdAt: "2026-08-25T14:00:00.000Z",
  };
}

describe("provider context epoch v2 authority", () => {
  it("keeps epoch baselines immutable while request admissions advance descendant heads", () => {
    const epoch = createProviderEpochReceiptV2(epochInput());
    const admission = createProviderRequestAdmissionReceipt({
      sessionId: epoch.sessionId,
      actorKey: epoch.actorKey,
      actorId: epoch.actorId,
      epoch: epoch.epoch,
      epochReceiptDigest: epoch.receiptDigest,
      previousAdmissionDigest: null,
      currentHeads: {
        historyHeadGenerationId: "history-2",
        promptHeadGenerationId: "prompt-1",
        factHeadDigest: digest("9"),
      },
      historyMessageCount: 2,
      historyFrontierDigest: digest("d"),
      factAppendIntentDigest: digest("c"),
      admittedFactRange: {
        previousHeadDigest: digest("2"),
        firstSequence: 4,
        lastSequence: 5,
        count: 2,
        factDigests: [digest("8"), digest("9")],
      },
      finalRequestDigest: digest("a"),
      deliveryConfirmationDigests: [digest("b")],
      admittedAt: "2026-08-25T14:01:00.000Z",
    });
    expect(epoch.baselineHeads.factHeadDigest).toBe(digest("2"));
    expect(admission.currentHeads.factHeadDigest).toBe(digest("9"));
    expect(Object.isFrozen(epoch)).toBe(true);
    expect(Object.isFrozen(admission)).toBe(true);
  });

  it("binds retained delivery provenance to exact successor facts", () => {
    const proof = createProviderContextCompactionProof({
      sessionId: "session-1",
      actorKey: "actor-key-1",
      sourceEpoch: 1,
      successorEpoch: 2,
      retained: [{
        namespace: "workflow-stage-context",
        sourceFactDigest: digest("1"),
        namespaceRevision: 7,
        payloadDigest: digest("2"),
        callRecordDigest: digest("3"),
        resultRecordDigest: digest("4"),
        requestAdmissionIntentDigest: digest("9"),
        requestAdmissionDigest: digest("5"),
        successorFactDigest: digest("6"),
      }],
      createdAt: "2026-08-25T14:00:00.000Z",
    });
    expect(proof.retained[0]?.requestAdmissionDigest).toBe(digest("5"));
    expect(proof.proofDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("imports legacy receipts once with exact reason mapping and rejects conflicts", () => {
    const runtime = new Map<string, unknown>();
    const legacyReceiptFacts = {
      schemaVersion: "provider.epoch-receipt/v1" as const,
      sessionId: "session-1",
      actorKey: "actor-key-1",
      actorId: "actor-id-1",
      epoch: 1,
      targetProviderId: "deepseek",
      targetProfileId: "deepseek-official-chat@1" as const,
      sourceMessageCount: 2,
      pendingToolCallIds: [],
      sourceFrontierDigest: digest("2"),
      handoffDigest: digest("3"),
      reason: "model_control" as const,
      createdAt: "2026-08-25T13:00:00.000Z",
    };
    const legacyReceipt = {
      ...legacyReceiptFacts,
      integrityDigest: computeProviderEpochReceiptIntegrityDigest(legacyReceiptFacts),
    };
    const first = importLegacyProviderContextAuthority({
      runtime,
      sourceTreeDigest: digest("1"),
      legacyReceipt,
      projectedFactDigest: digest("5"),
      targetReceipt: createProviderEpochReceiptV2({
        ...epochInput(),
        reason: "provider_model_profile_switch",
        compactionProofDigest: null,
      }),
    });
    const replay = importLegacyProviderContextAuthority({
      runtime,
      sourceTreeDigest: digest("1"),
      legacyReceipt: first.legacyReceipt,
      projectedFactDigest: digest("5"),
      targetReceipt: first.targetReceipt,
    });
    expect(replay).toEqual(first);
    expect(first.mappedReason).toBe("provider_model_profile_switch");

    expect(() => importLegacyProviderContextAuthority({
      runtime,
      sourceTreeDigest: digest("9"),
      legacyReceipt: first.legacyReceipt,
      projectedFactDigest: digest("5"),
      targetReceipt: first.targetReceipt,
    })).toThrow(ProviderContextEpochError);

    expect(() => importLegacyProviderContextAuthority({
      runtime: new Map(),
      sourceTreeDigest: digest("1"),
      legacyReceipt: { ...first.legacyReceipt, unexpected: true } as any,
      projectedFactDigest: digest("5"),
      targetReceipt: first.targetReceipt,
    })).toThrow("legacyReceipt fields are not exact");
    expect(() => importLegacyProviderContextAuthority({
      runtime: new Map(),
      sourceTreeDigest: digest("1"),
      legacyReceipt: { ...first.legacyReceipt, integrityDigest: digest("4") },
      projectedFactDigest: digest("5"),
      targetReceipt: first.targetReceipt,
    })).toThrow("legacy receipt integrity is invalid");
    expect(() => importLegacyProviderContextAuthority({
      runtime: new Map(),
      sourceTreeDigest: digest("1"),
      legacyReceipt: first.legacyReceipt,
      projectedFactDigest: digest("5"),
      targetReceipt: first.targetReceipt,
      unexpected: true,
    } as any)).toThrow("legacyImport fields are not exact");
  });
});
