import {expect,test} from 'bun:test'
import {projectParticipantTextInput} from '../../cell/packages/ai-runtime-host-capsule/src/participantInput'
test('text projection uses the exact sole admitted string slot; ambiguity requires structured input',()=>{
  expect(projectParticipantTextInput({type:'string'},'hello')).toBe('hello')
  expect(projectParticipantTextInput({type:'object',required:['value'],properties:{value:{type:'string'}}},'hello')).toEqual({value:'hello'})
  expect(projectParticipantTextInput({type:'object',properties:{request:{type:'string'}}},'hello')).toEqual({request:'hello'})
  for(const schema of [undefined,{type:'number'},{type:'object',properties:{}},{type:'object',required:['other'],properties:{value:{type:'string'}}},{type:'object',properties:{a:{type:'string'},b:{type:'string'}}},{type:'object',properties:{a:{type:'number'}}}])expect(()=>projectParticipantTextInput(schema,'hello')).toThrow('participant_structured_input_required')
})
