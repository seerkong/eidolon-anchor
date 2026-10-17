import { expect, test } from 'bun:test'
import type { RuntimeHostPort, ObservationFrame, AssociatedTurn, ConversationOperation } from '@cell/ai-runtime-host-contract'
import { authorizeDaemonPort } from '../../backend/packages/elysia/src/daemonAuthorization'
import { principal } from './helpers'

test('parent policy removes denied caller controls and hides questionnaire schemas; forbidden reconciliation cannot mutate', async () => {
  const request = { principal, requestId: 'policy' }, selector = { sessionId: 'session' }
  const turn: AssociatedTurn = { actorId: 'visible', turnId: 'turn', state: 'waiting_input', canCancel: true, pendingQuestionIds: ['question'] }
  const hidden = { ...turn, actorId: 'hidden', turnId: 'hidden-turn', pendingQuestionIds: ['hidden-question'] }
  const command = { commandId: 'command', epoch: 'epoch', state: 'accepted' as const, associatedTurn: turn }
  const denied = { ...command, commandId: 'hidden-command', associatedTurn: hidden }
  const question = { actorId: 'visible', turnId: 'turn', questionnaireId: 'question', state: 'pending' as const, canAnswer: true, schema: { title: 'private schema', questions: [] } }
  const snapshot: ObservationFrame = { kind: 'snapshot', requestId: 'policy', payload: { sessionId: 'session', epoch: 'epoch', seq: 1, cursor: 'cursor', actors: [], histories: [], pendingStreams: [],
    commands: [command, denied], turns: [turn, hidden], questions: [question, { ...question, actorId: 'hidden', turnId: 'hidden-turn', questionnaireId: 'hidden-question' }],
    callerControls: { commandIds: ['command', 'hidden-command'], turnIds: ['turn', 'hidden-turn'], questionnaireIds: ['question', 'hidden-question'] }, checkpoint: { state: 'saved' } } }
  const operation: ConversationOperation = { operationId: 'operation', sessionId: 'session', actorId: 'hidden', commandId: 'rewind', epoch: 'epoch', submittedEpoch: 'epoch', kind: 'rewind', state: 'unknown' }
  let reconciles = 0, closed = 0
  const child = { async conversationOperation(_r: unknown, _s: unknown, input: { reconcile?: boolean }) { if (input.reconcile) reconciles++; return operation },
    async subscribe() { return { close() { closed++ }, frames: { async *[Symbol.asyncIterator]() { yield snapshot; yield { kind: 'question.updated', epoch: 'epoch', seq: 2, cursor: 'cursor2', payload: { ...question, actorId: 'hidden' } } as ObservationFrame } } } },
  } as unknown as RuntimeHostPort
  const port = authorizeDaemonPort(child, { currentGrantsVersion: () => principal.grantsVersion,
    permits: (_principal, target) => target.kind !== 'actor' || target.actorId !== 'hidden' && !['cancel_turn', 'answer_question'].includes(target.action) })
  await expect(port.conversationOperation!(request, selector, { expectedEpoch: 'epoch', operationId: 'operation', reconcile: true })).rejects.toMatchObject({ status: 403 })
  expect(reconciles).toBe(0)
  const stream = await port.subscribe(request, selector, { actors: [] })
  const frames: ObservationFrame[] = []; for await (const frame of stream.frames) frames.push(frame)
  expect(frames).toHaveLength(1)
  const result = frames[0]; if (result.kind !== 'snapshot') throw new Error('missing_snapshot')
  expect(result.payload.callerControls).toEqual({ commandIds: ['command'], turnIds: ['turn'], questionnaireIds: ['question'] })
  expect(result.payload.turns[0].canCancel).toBe(false)
  expect(result.payload.commands[0].associatedTurn?.canCancel).toBe(false)
  expect(result.payload.questions[0]).toMatchObject({ canAnswer: false })
  expect(result.payload.questions[0].schema).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain('hidden')
  expect(closed).toBe(1)
})

test('global participant controls retain parent policy across IPC and denied actions never reach the worker',async()=>{
  const request={principal,requestId:'participant-policy'};
  const execution={sessionId:'session',actorId:'primary',admissionId:'admission',taskSpaceId:'space',taskId:'task',claimId:'claim',attempt:1,executionSessionRef:'claim-session'};
  const page={bindingKey:'binding',sessionId:'session',work:[{commandId:'request',task:{admissionId:'admission',taskSpaceId:'space',taskId:'task'},revision:1,status:'Running',attempt:1,canCancel:true,executions:[execution],questions:[{questionnaireId:'q',execution,state:'pending',canAnswer:true,questions:[{id:'q1',prompt:'Private approval',type:'text',required:true,choices:[]}]}]}],settings:{models:[],canSetModel:true,inputSchemaJson:'{}',attachments:{epoch:'e',actorId:'primary',textBytes:100,parts:1,mimeTypes:['text/plain']}}};
  let writes=0;
  const child={participantWork:async()=>page,actors:async()=>({actors:[{actorId:'primary',executionKind:'primary'}]}),submitExecution:async()=>{writes++},controlParticipant:async()=>{writes++},participantAttachment:async()=>{writes++},participantDirectory:async()=>{writes++}} as unknown as RuntimeHostPort;
  const port=authorizeDaemonPort(child,{currentGrantsVersion:()=>principal.grantsVersion,permits:(_p,target)=>target.kind==='actor'?['observe','read_history'].includes(target.action):target.kind!=='server'});
  const view=await port.participantWork!(request,{bindingKey:'binding'});
  expect(view.work[0]!.canCancel).toBe(false);expect(view.work[0]!.questions[0]!.canAnswer).toBe(false);expect(view.work[0]!.questions[0]!.questions).toEqual([]);
  expect(view.settings!.canSetModel).toBe(false);expect(view.settings!.attachments).toBeUndefined();
  for(const kind of ['cancel','answer','set_model'])await expect(port.controlParticipant!(request,{kind,bindingKey:'binding',commandId:'request'} as any)).rejects.toMatchObject({status:403});
  await expect(port.submitExecution!(request,{bindingKey:'binding'} as any)).rejects.toMatchObject({status:403});
  await expect(port.participantAttachment!(request,{bindingKey:'binding'} as any)).rejects.toMatchObject({status:403});
  await expect(port.participantDirectory!(request)).rejects.toMatchObject({status:403});expect(writes).toBe(0);
  const textOnly=authorizeDaemonPort(child,{currentGrantsVersion:()=>principal.grantsVersion,permits:(_p,target)=>target.kind!=='actor'||target.action!=='upload_attachment'});
  await expect(textOnly.submitExecution!(request,{bindingKey:'binding',attachments:[{filename:'file.txt',mime:'text/plain',text:'private',digest:'sha256:'+'0'.repeat(64)}]} as any)).rejects.toMatchObject({status:403});
  expect(writes).toBe(0);
});
