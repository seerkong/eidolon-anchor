import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ActorRuntimeFacetEnvelope } from "@cell/ai-core-contract"
import {
  createActor,
  createActorRuntimeFacetRegistry,
  createVM,
  dispatchActorRuntimeFacetEvent,
  hydrateActor,
  normalizeActorRuntimeFacetIndex,
  readActorRuntimeFacet,
  replaceActorRuntimeFacet,
  runActorRuntimeFacetProviderBoundary,
  serializeActor,
  serializeVM,
} from "@cell/ai-core-logic"
import { LocalFileRuntimeSnapshotRepository } from "@cell/ai-support"

const FACET_ID = "fixture.counter/v1"
const SCHEMA_VERSION = "fixture.counter-payload/v1"

function counterRegistry(options?: { withHook?: boolean }) {
  return createActorRuntimeFacetRegistry([{
    facetId: FACET_ID,
    schemaVersion: SCHEMA_VERSION,
    normalize(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("counter payload must be an object")
      }
      const count = (value as Record<string, unknown>).count
      if (!Number.isSafeInteger(count) || (count as number) < 0) {
        throw new Error("counter payload count must be a non-negative safe integer")
      }
      return { count: count as number }
    },
    onEvent: options?.withHook
      ? ({ envelope, event }) => event.kind === "beforeTurn"
        ? {
            expectedRevision: envelope.revision,
            nextValue: { count: Number((envelope.value as { count: number }).count) + 1 },
            reason: "fixture.before-turn",
          }
        : null
      : undefined,
  }])
}

function counterEnvelope(count = 1): ActorRuntimeFacetEnvelope {
  return {
    facetId: FACET_ID,
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    value: { count },
  }
}

describe("domain-neutral Actor runtime facets", () => {
  it("normalizes deterministic closed indexes and round-trips envelopes without runtime functions", () => {
    const registry = counterRegistry()
    const actor = createActor({
      key: "main",
      runtimeFacets: [
        counterEnvelope(2),
        {
          facetId: "aaa.fixture/v1",
          schemaVersion: "aaa.fixture-payload/v1",
          revision: 3,
          value: { z: 1, a: [true, null, "x"] },
        },
      ],
    })
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      runtimeContext: {
        actorFacetRuntime: createActorRuntimeFacetRegistry([
          ...registry.entries,
          {
            facetId: "aaa.fixture/v1",
            schemaVersion: "aaa.fixture-payload/v1",
            normalize: (value) => value,
          },
        ]),
      },
    })

    expect(Object.keys(actor.runtimeFacets)).toEqual(["aaa.fixture/v1", FACET_ID])
    expect(Object.keys(actor.runtimeFacets["aaa.fixture/v1"]!.value as object)).toEqual(["a", "z"])
    expect(Object.isFrozen(actor.runtimeFacets)).toBe(true)
    expect(Object.isFrozen(actor.runtimeFacets[FACET_ID]!.value)).toBe(true)

    const actorSnapshot = serializeActor(actor)
    expect(JSON.stringify(actorSnapshot.runtimeFacets)).toBe(JSON.stringify(actor.runtimeFacets))
    const restored = hydrateActor(actorSnapshot, { actorFacetRuntime: vm.runtimeContext.actorFacetRuntime })
    expect(restored.runtimeFacets).toEqual(actor.runtimeFacets)

    const vmSnapshot = serializeVM(vm)
    expect(JSON.stringify(vmSnapshot)).not.toContain("actorFacetRuntime")
    expect(JSON.stringify(vmSnapshot)).not.toContain("normalize")
  })

  it("rejects duplicate, sparse, accessor and non-JSON facet input without invoking getters", () => {
    expect(() => normalizeActorRuntimeFacetIndex([counterEnvelope(), counterEnvelope()]))
      .toThrow("duplicate")

    const sparse = new Array(2)
    sparse[0] = "first"
    const accessorValue: Record<string, unknown> = {}
    let getterRead = false
    Object.defineProperty(accessorValue, "secret", {
      enumerable: true,
      get() {
        getterRead = true
        return "must-not-run"
      },
    })

    for (const value of [sparse, accessorValue, new Date(), Number.NaN, () => null]) {
      expect(() => normalizeActorRuntimeFacetIndex([{ ...counterEnvelope(), value }]))
        .toThrow()
    }
    expect(getterRead).toBe(false)
  })

  it("fails unknown codecs and schema mismatches before actor registration or mutation", () => {
    const unknown = createActor({ key: "unknown", runtimeFacets: [counterEnvelope()] })
    const unknownBefore = unknown.runtimeFacets
    expect(() => createVM({ controlActorKey: unknown.key, actors: { unknown } }))
      .toThrow("codec")
    expect(unknown.runtimeFacets).toBe(unknownBefore)

    const mismatch = createActor({ key: "mismatch", runtimeFacets: [counterEnvelope()] })
    expect(() => createVM({
      controlActorKey: mismatch.key,
      actors: { mismatch },
      runtimeContext: {
        actorFacetRuntime: createActorRuntimeFacetRegistry([{
          facetId: FACET_ID,
          schemaVersion: "fixture.counter-payload/v2",
          normalize: (value) => value,
        }]),
      },
    })).toThrow("schema")

    const snapshot = serializeActor(mismatch)
    expect(() => hydrateActor(snapshot)).toThrow("codec")
  })

  it("owns whole-envelope replacement with revision CAS and applies the registered hook", () => {
    const actor = createActor({ key: "main", runtimeFacets: [counterEnvelope()] })
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      runtimeContext: { actorFacetRuntime: counterRegistry({ withHook: true }) },
    })

    expect(readActorRuntimeFacet(
      vm,
      { actorKey: actor.key, facetId: FACET_ID },
      { operationId: "read-1", occurredAt: 1 },
      {},
    )?.value).toEqual({ count: 1 })

    const replaced = replaceActorRuntimeFacet(
      vm,
      { actorKey: actor.key, facetId: FACET_ID },
      { expectedRevision: 0, nextValue: { count: 4 }, reason: "test" },
      {},
    )
    expect(replaced).toEqual(expect.objectContaining({ revision: 1, value: { count: 4 } }))

    const beforeConflict = actor.runtimeFacets
    expect(() => replaceActorRuntimeFacet(
      vm,
      { actorKey: actor.key, facetId: FACET_ID },
      { expectedRevision: 0, nextValue: { count: 9 }, reason: "stale" },
      {},
    )).toThrow("revision")
    expect(actor.runtimeFacets).toBe(beforeConflict)

    const afterHook = dispatchActorRuntimeFacetEvent(
      vm,
      { actorKey: actor.key, facetId: FACET_ID },
      { kind: "beforeTurn", operationId: "turn-1", occurredAt: 2 },
      {},
    )
    expect(afterHook?.revision).toBe(2)
    expect(afterHook?.value).toEqual({ count: 5 })
  })

  it("keeps codec and hook registries isolated per VM", () => {
    const actorA = createActor({ key: "a", runtimeFacets: [counterEnvelope()] })
    const actorB = createActor({ key: "b", runtimeFacets: [counterEnvelope()] })
    const vmA = createVM({
      controlActorKey: actorA.key,
      actors: { a: actorA },
      runtimeContext: { actorFacetRuntime: counterRegistry({ withHook: true }) },
    })
    const vmB = createVM({
      controlActorKey: actorB.key,
      actors: { b: actorB },
      runtimeContext: { actorFacetRuntime: counterRegistry() },
    })

    dispatchActorRuntimeFacetEvent(
      vmA,
      { actorKey: "a", facetId: FACET_ID },
      { kind: "beforeTurn", operationId: "a-turn", occurredAt: 1 },
      {},
    )
    dispatchActorRuntimeFacetEvent(
      vmB,
      { actorKey: "b", facetId: FACET_ID },
      { kind: "beforeTurn", operationId: "b-turn", occurredAt: 1 },
      {},
    )

    expect(actorA.runtimeFacets[FACET_ID]?.value).toEqual({ count: 2 })
    expect(actorB.runtimeFacets[FACET_ID]?.value).toEqual({ count: 1 })
    expect(vmA.runtimeContext.actorFacetRuntime).not.toBe(vmB.runtimeContext.actorFacetRuntime)
  })

  it("keeps the provider continuation on an invocation-scoped runtime port and config closed", async () => {
    const trace: string[] = []
    const actor = createActor({ key: "main", runtimeFacets: [counterEnvelope()] })
    const registry = createActorRuntimeFacetRegistry([{
      facetId: FACET_ID,
      schemaVersion: SCHEMA_VERSION,
      normalize: (value) => value,
      onEvent: ({ event }) => {
        trace.push(event.kind)
        return null
      },
      aroundProvider: async (_context, runtime) => {
        trace.push("boundary:enter")
        const result = await runtime.providerBoundary.run()
        trace.push("boundary:exit")
        return result
      },
    }])
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      runtimeContext: { actorFacetRuntime: registry },
    })
    const result = await runActorRuntimeFacetProviderBoundary(
      {
        actors: vm.actors,
        runtimeContext: vm.runtimeContext,
        providerBoundary: {
          run: async () => {
            trace.push("provider")
            return "ok"
          },
          abort: () => {},
        },
      },
      { actorKey: actor.key, facetId: FACET_ID },
      { kind: "aroundProvider", operationId: "provider-1", occurredAt: 1, providerAttempt: 1 },
      {},
    )
    expect(result).toBe("ok")
    expect(trace).toEqual(["aroundProvider", "boundary:enter", "provider", "boundary:exit"])
    expect(JSON.stringify(serializeVM(vm))).not.toContain("providerBoundary")

    let invoked = false
    await expect(runActorRuntimeFacetProviderBoundary(
      {
        actors: vm.actors,
        runtimeContext: vm.runtimeContext,
        providerBoundary: { run: async () => { invoked = true; return "bad" }, abort: () => {} },
      },
      { actorKey: actor.key, facetId: FACET_ID },
      { kind: "aroundProvider", operationId: "provider-2", occurredAt: 2, providerAttempt: 2 },
      { maxValueDepth: (() => 3) as any },
    )).rejects.toThrow(/config/)
    expect(invoked).toBe(false)
  })

  it("round-trips deterministic envelopes through local-file support and rejects invalid bytes before writing", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-facet-p1-t1-"))
    try {
      const actor = createActor({ key: "main", runtimeFacets: [counterEnvelope(7)] })
      const vm = createVM({
        controlActorKey: actor.key,
        actors: { [actor.key]: actor },
        runtimeContext: { actorFacetRuntime: counterRegistry() },
      })
      const repository = new LocalFileRuntimeSnapshotRepository(rootDir)
      await repository.writeSnapshot({
        vm: serializeVM(vm),
        actors: { [actor.key]: serializeActor(actor) },
        fibers: {},
      })

      const loaded = await repository.loadSnapshot()
      expect(loaded?.actors.main?.runtimeFacets).toEqual(actor.runtimeFacets)
      expect(JSON.stringify(loaded)).not.toContain("actorFacetRuntime")
      expect(JSON.stringify(loaded)).not.toContain("fixture.before-turn")

      const invalidRoot = path.join(rootDir, "invalid")
      const invalidRepository = new LocalFileRuntimeSnapshotRepository(invalidRoot)
      const invalidSnapshot = serializeActor(createActor({ key: "invalid" })) as any
      let getterRead = false
      invalidSnapshot.runtimeFacets = {
        [FACET_ID]: {
          ...counterEnvelope(),
          value: Object.defineProperty({}, "count", {
            enumerable: true,
            get() {
              getterRead = true
              return 1
            },
          }),
        },
      }
      await expect(invalidRepository.writeSnapshot({
        vm: { ...serializeVM(vm), controlActorKey: "invalid", actorKeys: ["invalid"] },
        actors: { invalid: invalidSnapshot },
        fibers: {},
      })).rejects.toThrow("own-data")
      expect(getterRead).toBe(false)
      expect(await invalidRepository.readManifest()).toBeNull()
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })
})
