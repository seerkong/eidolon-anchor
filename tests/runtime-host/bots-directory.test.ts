import { afterEach, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSubgraphPreparationFixture } from '../../cell/packages/ai-organ-logic/tests/workflow/fixtures/subgraph-worker-preparation-runtime'
import { addProductHolonPackage } from '../../cell/packages/ai-organ-logic/tests/workflow/fixtures/holonRepairResourceProductPackage'
import { EidolonAppResourceRegistryAdapter } from '@cell/ai-organ-logic/resources'
import { projectParticipantDirectory, readParticipantDirectory } from '../../cell/packages/ai-runtime-host-capsule/src/participantDirectory'
import { parseHostParticipantDirectory } from '@cell/ai-runtime-host-contract'
import { createHost } from '../../cell/packages/ai-runtime-host-capsule/src/host'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anchor-bots-directory-')); roots.push(root)
  const base = await createSubgraphPreparationFixture({ root })
  await addProductHolonPackage(root, base.resources, 2)
  const registry = new EidolonAppResourceRegistryAdapter({ workspaceRoot: root, layers: [{ id: 'workspace', rootDir: base.resources }] })
  return { root, base, snapshot: await registry.snapshot() }
}
test('real file-admitted member and organization expose exact identities and governance admission', async () => {
  const { snapshot } = await fixture()
  const directory = projectParticipantDirectory('workspace-a', snapshot)
  expect(directory.contacts).toHaveLength(2)
  const member = directory.contacts.find(c => c.recipient.kind === 'member')!
  const holon = directory.contacts.find(c => c.recipient.kind === 'holon')!
  expect(member).toMatchObject({ name: 'Order worker', available: true, parentRefs: [{ ref: 'holon-product', relation: 'primary' }] })
  expect(holon).toMatchObject({ name: 'Order artifact team', available: true })
  expect(member.recipient.admissionRef).toBe(snapshot.holonTaskRuntimeDefinitions[0]!.admission.admissionId)
  expect(member.recipient).not.toHaveProperty('actorId')
  expect(JSON.stringify(directory)).not.toContain('ORDER_RECIPE')
  expect(JSON.stringify(directory)).not.toContain('agentConfig')
})
test('topology alone does not grant execution; ambiguity and missing defaults fail closed', async () => {
  const { snapshot } = await fixture()
  const absent = projectParticipantDirectory('workspace-a', { ...snapshot, holonTaskRuntimeDefinitions: [] })
  expect(absent.contacts.every(c => !c.available && c.unavailableReason === 'admission_missing')).toBe(true)
  const ambiguous = projectParticipantDirectory('workspace-a', { ...snapshot, holonTaskRuntimeDefinitions: [...snapshot.holonTaskRuntimeDefinitions, ...snapshot.holonTaskRuntimeDefinitions] })
  expect(ambiguous.contacts.every(c => !c.available && c.unavailableReason === 'admission_ambiguous')).toBe(true)
  const byId = new Map(snapshot.registry.byId)
  for (const definition of snapshot.holonTaskRuntimeDefinitions) byId.delete(definition.definition.input.schemaRef.slice('resource://'.length))
  const opaque = projectParticipantDirectory('workspace-a', { ...snapshot, registry: { ...snapshot.registry, byId } })
  expect(opaque.contacts.every(c => !c.available && c.unavailableReason === 'input_schema_not_bound')).toBe(true)
  expect(() => parseHostParticipantDirectory({ ...absent, contacts: [{ ...absent.contacts[0], available: true }] })).toThrow()
  expect(() => parseHostParticipantDirectory({ ...absent, contacts: [absent.contacts[0], absent.contacts[0]] })).toThrow()
  expect(() => parseHostParticipantDirectory({ ...absent, credential: 'private' })).toThrow()
})
test('Host directory uses the effective VFS, starts no session, is stable across restart, and checks grants', async () => {
  const { root, base } = await fixture()
  const globalRoot = join(root, 'global'), workDir = join(globalRoot, 'daemon')
  await mkdir(join(workDir, '.eidolon'), { recursive: true }); await mkdir(globalRoot,{recursive:true})
  await cp(base.resources, join(workDir, '.eidolon', 'resources'), { recursive: true })
  // This legacy physical-registry fixture declares kinds that Effective VFS imports from its trusted owner.
  // Keep the resources, and use those trusted imports instead of redeclaring their authority.
  for (const kind of ['AgentContextPipeline', 'AgentMessageSource']) await rm(join(workDir, '.eidolon', 'resources', 'KindDefinitions', kind), { recursive: true })
  const request = { principal: { principalId: 'owner', grantsVersion: '1' }, requestId: 'directory-test' }
  let allowed = true
  const options = { workDir, globalRoot, globalAuthority:{daemonId:'fixture',globalWorkspaceKey:'global'}, authorization: { permits: () => allowed, currentGrantsVersion: () => '1' } }
  let host = await createHost(options)
  try {
    const first = await host.participantDirectory!(request)
    expect(first.contacts).toHaveLength(2)
    expect((await host.sessions(request, {})).sessions).toHaveLength(0)
    const bootstrap = { bindingKey: 'channel-product-primary', expectedServerInstanceId: host.capabilities(request).serverInstanceId,
      recipient: first.contacts.find(c => c.recipient.kind === 'member')!.recipient }
    await expect(host.openParticipant!(request, { ...bootstrap, expectedServerInstanceId: 'stale' })).rejects.toMatchObject({ status: 409 })
    await expect(host.openParticipant!(request, { ...bootstrap, recipient: { ...bootstrap.recipient, admissionRef: 'stale' } })).rejects.toMatchObject({ status: 409 })
    const bindings = await Promise.all(Array.from({ length: 6 }, () => host.openParticipant!(request, bootstrap)))
    expect(new Set(bindings.map(b => b.sessionId)).size).toBe(1)
    expect(bindings[0]!.sessionId).not.toBe(bootstrap.bindingKey)
    expect(await host.isBusy!()).toBe(false)
    expect((await host.sessions(request, {})).sessions).toHaveLength(0)
    allowed = false
    await expect(host.participantDirectory!(request)).rejects.toMatchObject({ status: 403 })
    allowed = true
    await host.close(); host = await createHost(options)
    expect(await host.participantDirectory!(request)).toEqual(first)
    expect(await host.openParticipant!(request, bootstrap)).toEqual(bindings[0]!)
    expect(await readParticipantDirectory(workDir, globalRoot)).toEqual(first)
    expect((await host.sessions(request, {})).sessions).toHaveLength(0)
  } finally { await host.close() }
}, 30000)
