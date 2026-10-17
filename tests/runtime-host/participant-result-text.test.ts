import { expect, test } from 'bun:test'
import { projectParticipantResultText } from '../../cell/packages/ai-runtime-host-capsule/src/participantResultText'

const textResult = { type: 'object', required: ['value'], additionalProperties: false, properties: { value: { type: 'string' } } }

test('only a declared single text result projects complete communication with real newlines and quotes', () => {
  const value = 'Complete first line\nSecond line with "evidence" and <script>text</script>'
  expect(projectParticipantResultText({ value }, textResult)).toBe(value)
  expect(projectParticipantResultText(JSON.stringify({ value }), textResult)).toBe(value)
  expect(projectParticipantResultText({ value: '' }, textResult)).toBe('')
})

test('arbitrary JSON, other schemas and malformed material are preserved without guessing or repair', () => {
  const raw = '{"value":"intentional JSON"}'
  expect(projectParticipantResultText(raw, { type: 'string' })).toBe(raw)
  expect(projectParticipantResultText(raw, { ...textResult, additionalProperties: true })).toBe(raw)
  expect(projectParticipantResultText(raw, undefined)).toBe(raw)
  const richer = { value: 'summary', evidence: ['source-a', 'source-b'] }
  expect(projectParticipantResultText(richer, textResult)).toBe(JSON.stringify(richer, null, 2))
  expect(projectParticipantResultText([richer], textResult)).toBe(JSON.stringify([richer], null, 2))
  const malformed = '{"value":"bare\nline"}'
  expect(projectParticipantResultText(malformed, textResult)).toBe(malformed)
})
