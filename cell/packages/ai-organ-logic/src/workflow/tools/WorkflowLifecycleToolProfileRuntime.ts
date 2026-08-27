type ToolFuncRegistryData = object

export type WorkflowLifecycleToolProfile = Readonly<{
  profileId: "eidolon.workflow-lifecycle-tools/v1"
  profileRevision: "1"
  admittedNames: readonly string[]
  admittedNamesDigest: string
  schemaDigest: string
}>

export type WorkflowLifecycleToolProfileRegistry = Readonly<{
  profiles: readonly WorkflowLifecycleToolProfile[]
  resolve(profileId: string, profileRevision: string): WorkflowLifecycleToolProfile
}>

const PROFILE_REGISTRIES = new WeakMap<object, WorkflowLifecycleToolProfileRegistry>()

export function bindWorkflowLifecycleToolProfileRegistry(
  toolRegistry: ToolFuncRegistryData,
  profileRegistry: WorkflowLifecycleToolProfileRegistry,
): void {
  const current = PROFILE_REGISTRIES.get(toolRegistry)
  if (current && current !== profileRegistry) {
    throw new Error("WORKFLOW_LIFECYCLE_TOOL_PROFILE_CONFLICT: tool registry is already bound")
  }
  PROFILE_REGISTRIES.set(toolRegistry, profileRegistry)
}

export function resolveWorkflowLifecycleToolProfileRegistry(
  toolRegistry: ToolFuncRegistryData,
): WorkflowLifecycleToolProfileRegistry {
  const registry = PROFILE_REGISTRIES.get(toolRegistry)
  if (!registry) {
    throw new Error("WORKFLOW_LIFECYCLE_TOOL_PROFILE_UNAVAILABLE: VM tool registry has no lifecycle profile binding")
  }
  return registry
}
