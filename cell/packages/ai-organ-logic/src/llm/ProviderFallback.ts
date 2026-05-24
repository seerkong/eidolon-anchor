export type ProviderFallbackChainResult<T> = {
  value: T;
  selectedModel: string;
  attemptedModels: string[];
  fallbackUsed: boolean;
};

export async function executeProviderFallbackChain<T>(
  candidates: string[],
  operation: (model: string, index: number) => Promise<T>,
): Promise<ProviderFallbackChainResult<T>> {
  const attemptedModels: string[] = [];
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index += 1) {
    const model = candidates[index];
    attemptedModels.push(model);
    try {
      const value = await operation(model, index);
      return {
        value,
        selectedModel: model,
        attemptedModels,
        fallbackUsed: index > 0,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Provider fallback chain exhausted"));
}
