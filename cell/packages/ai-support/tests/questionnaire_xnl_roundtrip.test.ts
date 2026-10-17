import { expect, test } from 'bun:test'
import type { QuestionnaireRow } from '@cell/ai-core-contract/runtime/Questionnaire'
import { parseQuestionnaireRowsXnl, serializeQuestionnaireRowsXnl } from '../src/runtime/QuestionnaireXnlStore'

test('optional nested questionnaire fields remain absent JSON properties after durable XNL roundtrip', () => {
  const row: QuestionnaireRow = {
    questionnaireId: 'q', toolCallId: 't', suspendPolicy: 'pause_all', status: 'pending',
    request: { questionnaireId: 'q', toolCallId: 't', kind: 'approval', suspendPolicy: 'pause_all', questions: [
      { id: 'text', prompt: '输入', type: 'text', required: true, choices: undefined, default: undefined, helpText: undefined },
      { id: 'choice', prompt: '选择', type: 'single_select', choices: [{ value: 'a', label: undefined }, 'b'] },
    ] },
  }
  const raw = serializeQuestionnaireRowsXnl([row])
  expect(raw).not.toContain('undefined')
  const restored = parseQuestionnaireRowsXnl(raw)[0]!
  expect(restored.request.questions).toEqual(JSON.parse(JSON.stringify(row.request.questions)))
  expect(restored.request.questions[0]!.choices ?? []).toEqual([])
  expect(restored.request.questions[1]!.choices).toEqual([{ value: 'a' }, 'b'])
})
