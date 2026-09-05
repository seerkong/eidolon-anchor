import { describe, expect, it } from "bun:test"
import type { HolonTaskRuntimeStorage } from "@cell/ai-organ-contract/organization/HolonTaskRuntimeStorage"
import { bootstrapLocalHolonTaskRuntime, mountLocalHolonTaskRuntimeSupport } from "../../src/organization/HolonTaskRuntimeComposition"

function fixtureVm() {
  const facets = new Map<string, unknown>()
  return {
    actorRuntime: {
      ensureFacet<T>(key: string, factory: () => T): T {
        if (!facets.has(key)) facets.set(key, factory())
        return facets.get(key) as T
      },
      getFacet<T>(key: string): T | undefined { return facets.get(key) as T | undefined },
    },
  }
}

describe("Holon outer composition", () => {
  it("requires explicit host effects and creates one lazy route instance per VM", () => {
    const vm = fixtureVm()
    const scope = { supportRoot: "/virtual/holon", registryRef: "resource://test.registry" as const }
    let created = 0
    const storageFactory = ({ supportRoot }: { supportRoot: string }): HolonTaskRuntimeStorage => {
      created += 1
      return {
        supportRoot,
        taskManager: { owner: {} as HolonTaskRuntimeStorage["taskManager"]["owner"] },
        journalStore: {
          read: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
          list: async () => [],
          writeImmutable: async () => {},
          withExclusive: async (_identity, operation) => operation(),
        },
        retainSubmission: async () => {},
      }
    }
    const now = () => 1000
    bootstrapLocalHolonTaskRuntime({ vm, ...scope })
    expect(() => mountLocalHolonTaskRuntimeSupport({ vm, ...scope }))
      .toThrow("EIDOLON_HOLON_TASK_STORAGE_FACTORY_MISSING")
    bootstrapLocalHolonTaskRuntime({ vm, ...scope }, { storageFactory, now })
    expect(created).toBe(0)
    const first = mountLocalHolonTaskRuntimeSupport({ vm, ...scope })
    expect(mountLocalHolonTaskRuntimeSupport({ vm, ...scope })).toBe(first)
    expect(created).toBe(1)
    expect(() => bootstrapLocalHolonTaskRuntime({ vm, ...scope }, { storageFactory: () => { throw new Error() }, now }))
      .toThrow("EIDOLON_HOLON_TASK_STORAGE_FACTORY_CONFLICT")
    const otherVm = fixtureVm()
    bootstrapLocalHolonTaskRuntime({ vm: otherVm, ...scope }, { storageFactory, now })
    expect(mountLocalHolonTaskRuntimeSupport({ vm: otherVm, ...scope })).not.toBe(first)
    expect(created).toBe(2)
    first.close()
  })
})
