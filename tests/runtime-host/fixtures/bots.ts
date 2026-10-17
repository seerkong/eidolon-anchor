import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createSubgraphPreparationFixture } from '../../../cell/packages/ai-organ-logic/tests/workflow/fixtures/subgraph-worker-preparation-runtime'
import { addProductHolonPackage, writeProductLeaderLedPolicy } from '../../../cell/packages/ai-organ-logic/tests/workflow/fixtures/holonRepairResourceProductPackage'

/** Authentic file-admitted organization/Agent recipe, scoped entirely to a caller-owned test root. */
export async function seedBotResources(root: string, workDir: string, options: {leaderLed?: boolean} = {}) {
  const authoring = join(root, 'authoring'); await mkdir(authoring, { recursive: true })
  const fixture = await createSubgraphPreparationFixture({ root: authoring })
  await addProductHolonPackage(authoring, fixture.resources, 2)
  await mkdir(join(workDir, '.eidolon'), { recursive: true })
  const target = join(workDir, '.eidolon', 'resources')
  await cp(fixture.resources, target, { recursive: true })
  for (const kind of ['AgentContextPipeline', 'AgentMessageSource']) await rm(join(target, 'KindDefinitions', kind), { recursive: true })
  if (options.leaderLed) await writeLeaderLedBotPolicy(target)
  return target
}

export async function writeLeaderLedBotPolicy(resources: string, declaration: unknown = {
  schemaVersion: 'eidolon.holon-governance-policy/v1', kind: 'leader_led', holonRef: 'holon-product', leaderMemberRef: 'member-worker',
}) {
  await writeProductLeaderLedPolicy(resources, declaration)
}
