/**
 * Domain-neutral derivation contracts.
 *
 * A derivation contract names the required method set of a data-graph
 * processing definition (initialize / reduce / project / decide ...). The
 * definitions are contract; the flow wiring reuses vendor primitives
 * (event logs, reducer projections, effect runners) with implementations
 * injected and asserted at runtime.
 */

export type DerivationContract = {
  contractId: string;
  requiredMethods: readonly string[];
};

export function createDerivationContract(input: {
  contractId: string;
  requiredMethods: readonly string[];
}): DerivationContract {
  const seen = new Set<string>();
  for (const method of input.requiredMethods) {
    if (seen.has(method)) {
      throw new Error(`derivation contract ${input.contractId} declares duplicate method: ${method}`);
    }
    seen.add(method);
  }
  return { contractId: input.contractId, requiredMethods: [...input.requiredMethods] };
}

/**
 * Returns the implementation when complete; throws naming every required
 * method that is missing or not a function. Extra methods are allowed.
 */
export function assertDerivationContract<TImplementation>(
  contract: DerivationContract,
  implementation: TImplementation,
): TImplementation {
  const missing = contract.requiredMethods.filter(
    (method) => typeof (implementation as Record<string, unknown>)?.[method] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      `derivation contract ${contract.contractId} requires methods: ${missing.join(", ")}`,
    );
  }
  return implementation;
}
