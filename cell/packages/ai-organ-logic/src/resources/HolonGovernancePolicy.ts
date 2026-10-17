import type { EffectiveResourceRegistry } from 'halfcode-compiler.xnl/resource-core'
import type { HolonTaskRuntimeDefinition } from '@cell/ai-organ-contract'
import type { EidolonHolonExecutionBindingProjection } from './HolonExecutionBindingProjection'
import { EidolonResourceRegistryError } from './EidolonResourceRegistryError'

export type AdmittedLeaderLedHolonPolicy = Readonly<{
  kind: 'leader_led'
  holonRef: string
  leaderMemberRef: string
  name: string
  memberRefs: readonly string[]
}>

/** Explicit resource authority; absence preserves the existing autonomous route. */
export function projectHolonGovernancePolicy(
  registry: EffectiveResourceRegistry,
  definition: HolonTaskRuntimeDefinition,
  projection: EidolonHolonExecutionBindingProjection,
): AdmittedLeaderLedHolonPolicy | undefined {
  const fail = (): never => { throw new EidolonResourceRegistryError('EIDOLON_HOLON_GOVERNANCE_POLICY_INVALID', 'Leader-led policy must select the exact frozen organization, leader, and AI binding.') }
  const binding = projection.binding
  const profileRef = binding.adapter.kind === 'ai-agent' ? binding.adapter.runtimeProfileRef : definition.taskSpace.policyRef
  const policy = registry.byId.get(profileRef.slice('resource://'.length))?.resource
  const value = policy?.node.properties.value
  const definitionValue = registry.byId.get(definition.taskSpace.policyRef.slice('resource://'.length))?.resource?.node.properties.value
  const declaresGovernance = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && Object.hasOwn(value, 'holonGovernance'))
  if (!declaresGovernance(value) && !declaresGovernance(definitionValue)) return undefined
  if (!declaresGovernance(value) || profileRef !== definition.taskSpace.policyRef) return fail()
  const declaration = value.holonGovernance
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) return fail()
  const fields = declaration as Record<string, unknown>
  const keys = ['schemaVersion', 'kind', 'holonRef', 'leaderMemberRef']
  if (Object.keys(fields).length !== keys.length || keys.some(key => !Object.hasOwn(fields, key))
    || fields.schemaVersion !== 'eidolon.holon-governance-policy/v1' || fields.kind !== 'leader_led') return fail()
  for (const key of ['holonRef', 'leaderMemberRef']) {
    const ref = fields[key]
    if (typeof ref !== 'string' || !ref || ref !== ref.trim() || ref !== ref.normalize('NFC') || /[\u0000-\u001f\u007f]/.test(ref)) return fail()
  }
  if (binding.adapter.kind !== 'ai-agent' || binding.adapter.runtimeProfileRef !== definition.taskSpace.policyRef
    || binding.target.kind !== 'member' || binding.target.memberRef !== fields.leaderMemberRef
    || projection.snapshot.rootHolonRef !== fields.holonRef || definition.rootHolonRef !== fields.holonRef
    || !projection.closureResourceIds.includes(policy!.resourceId)) return fail()
  const records = projection.snapshot.records
  const holon = records.find(record => record.kind === 'HolonVersion' && record.holonId === fields.holonRef)
  const members = records.filter(record => record.kind === 'Member' && records.some(membership =>
    membership.kind === 'HolonMembershipVersion' && membership.parentHolonId === fields.holonRef && membership.subjectId === record.subjectId))
  if (!holon || holon.kind !== 'HolonVersion' || !members.some(member => member.id === fields.leaderMemberRef)) return fail()
  return Object.freeze({ kind: 'leader_led', holonRef: fields.holonRef as string, leaderMemberRef: fields.leaderMemberRef as string,
    name: holon.name, memberRefs: Object.freeze(members.map(member => member.id).sort()) })
}
