import { isAbsolute } from 'node:path'
import {parseAgentAdapterConfigureCommand,parseAgentAdapterSendCommand,parseAgentAdapterSelector,parseAgentAdapterInterruptCommand} from '@cell/ai-runtime-host-contract'
import { createDaemon } from '@cell/ai-runtime-host-capsule'
import { createAnchorHttpHost, RequestFailure, body, json,parseBody } from './runtimeRoutes'
import { validateRuntimeSecurity, type RuntimeSecurity } from './runtimeAuth'
import type { HttpListenOptions } from './httpHost'
import { authorizeDaemonPort } from './daemonAuthorization'
import { createParticipantA2A } from './participantA2A'
import { join } from 'node:path'

export async function serveDaemon(options: Parameters<typeof createDaemon>[0] & { listen?: HttpListenOptions; security: RuntimeSecurity; onStop?: () => void }) {
  validateRuntimeSecurity(options.listen ?? {}, options.security)
  const daemon = await createDaemon({...options,authorization:options.security.authorization,authorizeSchedulePort:port=>authorizeDaemonPort(port,options.security.authorization)})
  const participants = createParticipantA2A(join(daemon.globalWorkspace, '.eidolon', 'a2a'))
  let grantGuard: ReturnType<typeof setInterval> | undefined
  const server = createAnchorHttpHost({ listen: options.listen, security: options.security, close: async () => { clearInterval(grantGuard); await daemon.close(); participants.close() },
    async resolveScope(request, context, parts) {
      if (context.principal.principalId !== (options.principalId ?? 'local-owner') || context.principal.grantsVersion !== (options.grantsVersion ?? '1')) throw new RequestFailure(403, 'forbidden')
      if (!options.security.authorization.permits(context.principal, { kind: 'server', action: 'list_sessions' })) throw new RequestFailure(403, 'forbidden')
      const cap = daemon.capabilities(), requestId = context.requestId, method = request.method
      const query = new URL(request.url).searchParams
      const only = (value: string) => { if (method !== value) throw new RequestFailure(405, 'method_not_allowed') }
      const precondition = () => { if (request.headers.get('x-eidolon-daemon-instance') !== cap.daemonInstanceId) throw new RequestFailure(409, 'daemon_instance_mismatch') }
      if (parts[0] !== 'v1' || parts[1] !== 'daemon' && parts[1] !== 'workspaces') throw new RequestFailure(404, 'route_not_found')
      if (parts[1] === 'daemon') {
        if(parts.length===3&&parts[2]==='execution-environments'){only('GET');if(query.size)throw new RequestFailure(400,'invalid_schema');precondition();return json(daemon.environments(context),requestId)}
        if(parts[2]==='agent-adapters'){
          if(query.size)throw new RequestFailure(400,'invalid_schema');precondition();if(!daemon.agents)throw new RequestFailure(503,'agent_adapters_unavailable');
          if(parts.length===3){only('GET');return json(await daemon.agents.directory(context),requestId)}
          if(parts.length===4&&parts[3]==='configure'){only('POST');return json(await daemon.agents.configure(context,await parseBody(request,parseAgentAdapterConfigureCommand)),requestId)}
          if(parts.length===5&&parts[3]==='configuration-results'){only('GET');return json(await daemon.agents.configurationResult(context,parts[4]!),requestId)}
          if(parts.length===4&&parts[3]==='send'){only('POST');return json(await daemon.agents.send(context,await parseBody(request,parseAgentAdapterSendCommand)),requestId,202,16*1024*1024)}
          if(parts.length===4&&parts[3]==='observe'){only('POST');return json(await daemon.agents.observe(context,await parseBody(request,parseAgentAdapterSelector)),requestId,200,16*1024*1024)}
          if(parts.length===4&&parts[3]==='interrupt'){only('POST');return json(await daemon.agents.interrupt(context,await parseBody(request,parseAgentAdapterInterruptCommand)),requestId,200,16*1024*1024)}
          throw new RequestFailure(404,'route_not_found');
        }
        if(parts[2]==='schedules'){
          if(query.size)throw new RequestFailure(400,'invalid_schema')
          if(!daemon.schedules)throw new RequestFailure(503,'schedules_unavailable')
          precondition()
          if(parts.length===3){only('GET');return json(daemon.schedules.view(context.principal),requestId,200,16*1024*1024)}
          if(parts.length===4&&parts[3]==='commands'){only('POST');return json(await daemon.schedules.command(context.principal,await body(request)),requestId)}
          if(parts.length===4&&parts[3]!=='commands'){only('GET');return json(daemon.schedules.view(context.principal,parts[3]),requestId,200,16*1024*1024)}
          if(parts.length===5&&parts[3]==='commands'){only('GET');return json(daemon.schedules.receipt(context.principal,parts[4]!),requestId)}
          throw new RequestFailure(404,'route_not_found')
        }
        if (query.size) throw new RequestFailure(400, 'invalid_schema')
        if (parts.length === 2) { only('GET'); return json(cap, requestId) }
        if (parts.length === 3 && parts[2] === 'stop') {
          only('POST'); precondition()
          if (!options.security.authorization.permits(context.principal, { kind: 'server', action: 'stop_daemon' })) throw new RequestFailure(403, 'forbidden')
          setTimeout(() => { void server.close().then(() => options.onStop?.()) }, 20)
          return json({ stopping: true }, requestId, 202)
        }
        throw new RequestFailure(404, 'route_not_found')
      }
      precondition()
      const controlRoute = parts.length <= 3 || parts.length === 4 && ['open', 'close'].includes(parts[3])
      if (controlRoute && method !== 'GET' && !options.security.authorization.permits(context.principal, { kind: 'server', action: 'manage_workspaces' })) throw new RequestFailure(403, 'forbidden')
      if (parts.length === 2) {
        if (query.size) throw new RequestFailure(400, 'invalid_schema')
        if (method === 'GET') return json({ workspaces: daemon.workspaces() }, requestId)
        only('POST')
        const value = await body(request) as { workDir?: unknown }
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.workDir !== 'string' || !isAbsolute(value.workDir) || value.workDir.length > 4096) throw new RequestFailure(400, 'invalid_schema')
        return json(await daemon.register(value.workDir), requestId, 201)
      }
      const key = parts[2]
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(key ?? '')) throw new RequestFailure(400, 'invalid_schema')
      if (parts.length === 3) {
        if (query.size) throw new RequestFailure(400, 'invalid_schema')
        if (method === 'DELETE') { daemon.remove(key); return json({ removed: true }, requestId) }
        only('GET'); return json(daemon.workspaces().find(w => w.workspaceKey === key) ?? (() => { throw new RequestFailure(404, 'workspace_not_found') })(), requestId)
      }
      if (parts.length === 4 && ['open', 'close'].includes(parts[3])) {
        only('POST'); if (query.size) throw new RequestFailure(400, 'invalid_schema')
        if (parts[3] === 'open') return json(await daemon.open(key), requestId)
        await daemon.closeWorkspace(key); return json({ closed: true }, requestId)
      }
      const scope = daemon.scope(key)
      if (request.headers.get('x-eidolon-workspace-instance') !== scope.port.capabilities(context).serverInstanceId) throw new RequestFailure(409, 'workspace_instance_mismatch')
      if (parts[3] === 'a2a' || parts[3] === '.well-known') {
        if (key !== cap.globalWorkspaceKey) throw new RequestFailure(403, 'global_worker_required')
        if (!(parts.length === 4 && parts[3] === 'a2a' || parts.length === 5 && parts[3] === '.well-known' && parts[4] === 'agent-card.json')) throw new RequestFailure(404, 'route_not_found')
        return participants.handle(request, context, authorizeDaemonPort(scope.port, options.security.authorization), new URL(request.url).origin + `/v1/workspaces/${key}`)
      }
      return { runtime: authorizeDaemonPort(scope.port, options.security.authorization), workspace: { workspaceId: scope.workspace.workspaceId, workDir: scope.workspace.workDir }, parts: ['v1', ...parts.slice(3)] }
    },
  })
  try {
    await server.start()
    grantGuard = setInterval(() => {
      if (options.security.authorization.currentGrantsVersion(options.principalId ?? 'local-owner') !== (options.grantsVersion ?? '1')) void server.close()
    }, 1000)
    return { ...server, daemon }
  } catch (error) { await server.close(); throw error }
}
