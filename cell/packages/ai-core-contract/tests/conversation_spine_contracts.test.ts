import { describe, expect, it } from "bun:test"

import {
  AI_RUNTIME_DATA_COMPONENT_IDS,
  createAiRuntimeDataSubgraphRegistry,
  CONVERSATION_REDUCER_DERIVATION_CONTRACT,
  MESSAGE_ASSEMBLY_DERIVATION_CONTRACT,
  MATERIALIZATION_DERIVATION_CONTRACT,
  assertConversationReducerDerivation,
  assertMessageAssemblyDerivation,
  assertMaterializationDerivation,
} from "../src"

describe("stage components join the registry (10 -> 13 -> 14)", () => {
  it("declares the three stage components", () => {
    expect(AI_RUNTIME_DATA_COMPONENT_IDS).toContain("ingress_stage")
    expect(AI_RUNTIME_DATA_COMPONENT_IDS).toContain("lexical_syntactic_stage")
    expect(AI_RUNTIME_DATA_COMPONENT_IDS).toContain("semantic_event")
    expect(AI_RUNTIME_DATA_COMPONENT_IDS.length).toBe(14)
  })

  it("stage owner boundaries hold in the registry", () => {
    const registry = createAiRuntimeDataSubgraphRegistry()
    expect(registry.contracts.length).toBe(14)
    expect(registry.findOwnerOfFactNode("stage.semantic_events")).toBe("semantic_event")
    expect(registry.classifyFactNode("stage.semantic_events")).toBe("domain_canonical_event")
    expect(registry.findOwnerOfFactNode("stage.ingress_timeline")).toBe("ingress_stage")
    expect(registry.findOwnerOfFactNode("stage.parser_state")).toBe("lexical_syntactic_stage")
    const lexical = registry.getContract("lexical_syntactic_stage")
    expect(lexical?.notOwnedHere).toContain("stage.semantic_events")
    const semantic = registry.getContract("semantic_event")
    expect(semantic?.notOwnedHere).toContain("history.committed_messages")
    expect(semantic?.forbiddenLiveReads).toContain("stage.parser_state")
  })
})

describe("conversation derivation contracts", () => {
  it("declares the three method sets", () => {
    expect(CONVERSATION_REDUCER_DERIVATION_CONTRACT.requiredMethods).toEqual([
      "initializeConversationState",
      "applyCommand",
      "projectVisibleHistory",
    ])
    expect(MESSAGE_ASSEMBLY_DERIVATION_CONTRACT.requiredMethods).toEqual([
      "initializeAssemblyState",
      "reduceSemanticEvent",
    ])
    expect(MATERIALIZATION_DERIVATION_CONTRACT.requiredMethods).toEqual([
      "materializeProviderContext",
    ])
  })

  it("rejects incomplete implementations naming the missing method", () => {
    expect(() =>
      assertConversationReducerDerivation({
        initializeConversationState: () => ({}),
        applyCommand: (s: unknown) => ({ state: s, events: [] }),
      } as never),
    ).toThrow(/projectVisibleHistory/)
    expect(() => assertMessageAssemblyDerivation({ initializeAssemblyState: () => ({}) } as never)).toThrow(
      /reduceSemanticEvent/,
    )
    expect(() => assertMaterializationDerivation({} as never)).toThrow(/materializeProviderContext/)
  })

  it("accepts complete implementations", () => {
    const reducer = {
      initializeConversationState: () => ({}) as never,
      applyCommand: (s: never) => ({ state: s, events: [] }),
      projectVisibleHistory: () => [],
    }
    expect(assertConversationReducerDerivation(reducer as never)).toBe(reducer as never)
    const assembly = {
      initializeAssemblyState: () => ({}) as never,
      reduceSemanticEvent: (s: never) => ({ state: s }),
    }
    expect(assertMessageAssemblyDerivation(assembly as never)).toBe(assembly as never)
    const materialization = { materializeProviderContext: () => [] as never }
    expect(assertMaterializationDerivation(materialization as never)).toBe(materialization as never)
  })
})
