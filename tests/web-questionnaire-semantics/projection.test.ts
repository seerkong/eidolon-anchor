import {expect, test} from 'bun:test';
import {projectHostQuestion} from '../../cell/packages/ai-runtime-host-capsule/src/questionnaireHost';
import {parseObservationFrame} from '../../cell/packages/ai-runtime-host-contract/src';

test('core question semantics survive both live DTO and snapshot transport without invented flags', () => {
  const row = projectHostQuestion({questionnaireId:'q',toolCallId:'tool',kind:'form',intro:'Intro',title:'Typed',suspendPolicy:'continue_others',questions:[
    {id:'n',prompt:'Number',type:'number',required:false,default:0,helpText:'zero allowed'},
    {id:'j',prompt:'JSON',type:'json',required:true,default:{nested:[false,null,-1]}},
    {id:'m',prompt:'Select',type:'multi_select',choices:['a','b'],default:['b']},
    {id:'y',prompt:'Confirm',type:'yes_no',default:false},
  ]}, 'actor','turn');
  const live = {kind:'question.updated',epoch:'e',seq:1,cursor:'c',payload:row};
  expect(parseObservationFrame(JSON.parse(JSON.stringify(live)))).toEqual(live);
  const snapshot = {kind:'snapshot',requestId:'r',payload:{sessionId:'s',epoch:'e',seq:1,cursor:'c',actors:[],histories:[],pendingStreams:[],commands:[],turns:[],questions:[row],callerControls:{commandIds:[],turnIds:[],questionnaireIds:[]},checkpoint:{state:'saved'}}};
  expect(parseObservationFrame(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  expect(row.schema).toMatchObject({version:2,kind:'form',intro:'Intro',suspendPolicy:'continue_others'});
  expect(row.schema!.questions[0]).toMatchObject({prompt:'Number',type:'number',required:false,defaultJson:'0',helpText:'zero allowed'});
  expect(row.schema!.questions[2]).not.toHaveProperty('required');
  expect(row.schema!.questions[3]).toMatchObject({defaultJson:'false'});
  expect(() => parseObservationFrame({...live,payload:{...row,schema:{...row.schema,questions:[{id:'q',prompt:'x',defaultJson:'{broken'}]}}})).toThrow();
  expect(() => parseObservationFrame({...live,payload:{...row,schema:{...row.schema,questions:[{id:'q',prompt:'x',defaultJson:'x'.repeat(17000)}]}}})).toThrow();
});

test('original legacy schema remains accepted and terminal flags are not inferred from UI state', () => {
  const frame={kind:'question.updated',epoch:'e',seq:1,cursor:'c',payload:{actorId:'a',turnId:'t',questionnaireId:'q',state:'cancelled',canAnswer:false,schema:{title:'Legacy',questions:[{id:'q',prompt:'Answer'}]}}};
  expect(parseObservationFrame(frame)).toEqual(frame);
  expect(frame.payload.canAnswer).toBe(false);
});
test('unrepresentable defaults are rejected before projection instead of silently losing semantics',()=>{
 for(const value of [Infinity,{value:undefined},()=>1])expect(()=>projectHostQuestion({questionnaireId:'q',toolCallId:'t',kind:'form',suspendPolicy:'continue_others',questions:[{id:'n',prompt:'Value',type:'json',default:value}]},'a','t')).toThrow('question_default_not_json');
});
