import {test,expect} from 'bun:test';
import {workspaceWorkerRuntimeConfig} from '../../cell/packages/ai-runtime-host-capsule/src/daemonWorker';
test('daemon worker installs observation effects locally only with explicit capture opt-in',()=>{
 const factory=()=>null;
 expect(workspaceWorkerRuntimeConfig({model:'fixture'},factory)).toEqual({model:'fixture'});
 const configured=workspaceWorkerRuntimeConfig({model:'fixture',metadata:{sandbox_permissions:{sandbox_mode:'workspace-write'}},captureProviderRequests:true},factory);
 expect(configured.providerRequestObservationBindingFactory).toBe(factory);
 expect(configured.metadata).toEqual({sandbox_permissions:{sandbox_mode:'workspace-write'}});
 expect(configured).not.toHaveProperty('captureProviderRequests');
 expect(()=>workspaceWorkerRuntimeConfig({captureProviderRequests:true})).toThrow('provider_observation_binding_unavailable');
});
