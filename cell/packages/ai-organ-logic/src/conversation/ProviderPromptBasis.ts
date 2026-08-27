export function retainStableProviderPromptBasisRefs<T extends Readonly<{ refKind: string }>>(
  refs: readonly T[] | undefined,
): T[] | undefined {
  return refs?.filter((ref) => ref.refKind !== "overlay" && ref.refKind !== "workflow_status")
}
