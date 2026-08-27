import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import {
  createActorDurableMaterial,
  readActorDurableMaterialText,
} from "@cell/ai-core-logic/runtime/ActorDurableMaterial";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { hydrateActor, serializeActor } from "@cell/ai-core-logic/runtime/snapshot/actorSnapshot";

describe("Actor-owned durable materials", () => {
  it("round-trips closed content-addressed bytes through the Actor snapshot", () => {
    const material = createActorDurableMaterial("frozen source bytes", "text/plain; charset=utf-8");
    const actor = createActor({
      key: "material-owner",
      durableMaterials: { [material.digest]: material },
    });

    const recovered = hydrateActor(structuredClone(serializeActor(actor)));
    expect(readActorDurableMaterialText(recovered, material.digest)).toBe("frozen source bytes");
    expect(recovered.durableMaterials).toEqual(actor.durableMaterials);
    expect(Object.isFrozen(recovered.durableMaterials)).toBe(true);
  });

  it("rejects extra fields, non-canonical bytes and digest mismatches", () => {
    const material = createActorDurableMaterial("trusted");
    expect(() => createActor({
      key: "extra-field",
      durableMaterials: { [material.digest]: { ...material, domain: "workflow" } },
    })).toThrow(/exact closed material shape/);
    expect(() => createActor({
      key: "digest-mismatch",
      durableMaterials: { [material.digest]: { ...material, bytes: Buffer.from("tampered").toString("base64") } },
    })).toThrow(/does not address bytes/);
    expect(() => createActor({
      key: "non-canonical",
      durableMaterials: { [material.digest]: { ...material, bytes: `${material.bytes}\n` } },
    })).toThrow(/canonical base64/);
  });

  it("keeps the generic contract and processor free of Workflow knowledge", () => {
    const sources = [
      "cell/packages/ai-core-contract/src/runtime/ActorDurableMaterial.ts",
      "cell/packages/ai-core-logic/src/runtime/ActorDurableMaterial.ts",
    ].map((file) => readFileSync(file, "utf8")).join("\n");
    expect(sources).not.toMatch(/workflow/i);
  });
});
