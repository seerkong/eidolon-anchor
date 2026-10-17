import {expect,test} from 'bun:test'
import {transitionLeaderLedHolonGovernance as transition} from '../../cell/packages/ai-organ-logic/src/organization/LeaderLedHolonGovernance'
import type {LeaderLedHolonState} from '@cell/ai-core-contract/runtime/AiAgentActor'

const state:LeaderLedHolonState={governance:'leader_led',holonId:'original-org',name:'Delivery',memberIds:['leader','worker'],leaderMemberId:'leader',watchState:'unwatched',routes:{}}
const assign={kind:'assign' as const,holonId:'original-org',routeId:'route',initiatorActorId:'actor-original',initiatorActorKey:'initiator',replyMode:'stream' as const,content:'original work'}
test('original leader-led governance routes through organization, preserves initiator and explicitly settles only its assigned leader',()=>{
 const routed=transition(state,assign,1)
 expect(state.routes).toEqual({});expect(routed.state.routes.route).toMatchObject({status:'routed',leaderMemberId:'leader',initiatorActorId:'actor-original'})
 expect(routed.effects).toEqual([{kind:'dispatch_leader',leaderMemberId:'leader',holonId:'original-org',routeId:'route',replyMode:'stream',content:'original work'}])
 expect(transition(routed.state,assign,2).effects).toEqual([])
 const event={kind:'event' as const,holonId:'original-org',routeId:'route',leaderMemberId:'leader',eventType:'leader_progress' as const,text:'complete stage'}
 const streamed=transition(routed.state,event,3)
 expect(streamed.effects).toEqual([{kind:'reply',actorKey:'initiator',actorId:'actor-original',text:'complete stage'}])
 const result={kind:'result' as const,holonId:'original-org',routeId:'route',leaderMemberId:'leader',text:'complete result'}
 const done=transition(streamed.state,result,4)
 expect(done.state.routes.route).toMatchObject({status:'completed',resultText:'complete result',eventCount:1})
 expect(done.effects).toEqual([{kind:'reply',actorKey:'initiator',actorId:'actor-original',text:'complete result'},{kind:'settled',routeId:'route',resultText:'complete result'}])
 expect(transition(done.state,result,5).state).toBe(done.state)
 expect(transition(done.state,event,6).effects).toEqual([])
});
test('foreign organization, unassigned leader, missing route and failed/cancelled routes cannot publish or settle a reply',()=>{
 const routed=transition(state,assign,1).state
 const result={kind:'result' as const,holonId:'original-org',routeId:'route',leaderMemberId:'leader',text:'complete result'}
 for(const bad of [{...result,holonId:'foreign'},{...result,leaderMemberId:'worker'},{...result,routeId:'missing'}]){
  expect(transition(routed,bad,2).state).toBe(routed);expect(transition(routed,bad,2).effects).toEqual([])
 }
 for(const status of ['cancelled','failed'] as const){const stopped={...routed,routes:{route:{...routed.routes.route!,status}}};expect(transition(stopped,result,2).state).toBe(stopped)}
 for(const bad of [{...assign,holonId:'foreign'},{...assign,routeId:''},{...assign,initiatorActorId:''}])expect(transition(state,bad,1).state).toBe(state)
 const noLeader=transition({...state,leaderMemberId:null},assign,1)
 expect(noLeader.state.routes.route?.status).toBe('failed');expect(noLeader.effects).toEqual([])
 const outsider=transition({...state,leaderMemberId:'outsider'},assign,1)
 expect(outsider.state.routes.route?.status).toBe('failed');expect(outsider.effects).toEqual([])
});
