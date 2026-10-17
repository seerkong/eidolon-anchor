import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHostSessionRegistry } from '@cell/ai-runtime-host-support'
import { emptyContext } from './fixtures/participant'

test('committed execution material stays immutable across reopen, source-key reads and conflicting projection writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'committed-output-'))
  let registry = openHostSessionRegistry(root)
  const scope = { principalId: 'owner', bindingKey: 'channel' }
  const recipient = { kind: 'member' as const, ref: 'member', ownerScopeRef: 'global', bindingRef: 'binding', bindingDigest: 'digest', admissionRef: 'admission' }
  const source = { admissionId: 'admission', taskSpaceId: 'space', taskId: 'task' }
  const message = { commandId: 'command', kind: 'result' as const, text: 'Committed complete material', artifactRefs: [], source }
  try {
    registry.executionOutputs.accept(scope, { bindingKey: scope.bindingKey, recipient, commandId: message.commandId, text: 'input', contextCut: emptyContext() }, 1, source)
    const committed = registry.executionOutputs.publish(scope, 'settlement:receipt', message, 2)
    expect(registry.executionOutputs.committedOutput(scope, 'settlement:receipt')).toEqual(committed)
    expect(registry.executionOutputs.committedOutput({ ...scope, bindingKey: 'other' }, 'settlement:receipt')).toBeUndefined()
    expect(registry.executionOutputs.committedOutput({ ...scope, principalId: 'foreign' }, 'settlement:receipt')).toBeUndefined()
    expect(registry.executionOutputs.committedOutput(scope, 'settlement:other-receipt')).toBeUndefined()
    registry.close(); registry = openHostSessionRegistry(root)
    expect(registry.executionOutputs.committedOutput(scope, 'settlement:receipt')).toEqual(committed)
    expect(() => registry.executionOutputs.publish(scope, 'settlement:receipt', { ...message, text: 'A different projection' }, 3)).toThrow('participant_publication_conflict')
    expect(registry.executionOutputs.outputs(scope).outputs).toEqual([committed])
  } finally { registry.close(); await rm(root, { recursive: true, force: true }) }
})
