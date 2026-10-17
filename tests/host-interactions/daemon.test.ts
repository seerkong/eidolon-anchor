import {expect,test} from 'bun:test';
import {fixture,server,client} from '../daemon/helpers';
test('actual daemon HTTP and worker IPC expose original host registrations with epoch guard',async()=>{
 const f=await fixture(),s=await server(f),request=client(s);
 try{
  const workspace=await s.daemon.register(f.a),opened=await s.daemon.open(workspace.workspaceKey),base=`/workspaces/${workspace.workspaceKey}`;
  const created=await request(base+'/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commandId:'host-session',profileId:'ai-coding',expectedServerInstanceId:opened.serverInstanceId})},opened.serverInstanceId);expect(created.status).toBe(201);const session=await created.json();
  const view=await request(base+`/sessions/${session.sessionId}/host-interactions?expectedEpoch=${session.epoch}`,{},opened.serverInstanceId);expect(view.status).toBe(200);expect((await view.json()).hosts).toEqual([]);
  expect((await request(base+`/sessions/${session.sessionId}/host-interactions?expectedEpoch=stale`,{},opened.serverInstanceId)).status).toBe(409);
 }finally{await s.close();await f.cleanup();}
},20000);
