import { serveDaemon } from '../../../backend/packages/elysia/src/daemonServe'
import { security, cli } from '../helpers'

const server = await serveDaemon({ globalRoot: process.env.TEST_DAEMON_ROOT!, security, listen: { port: 0 }, runtimeConfig: { mcp: false },
  workerCommand: [process.execPath, '--preload', new URL('./provider.ts', import.meta.url).pathname, cli, '__daemon-worker'] })
console.log(JSON.stringify({ address: server.address, capabilities: server.daemon.capabilities() }))
process.once('SIGTERM', () => { void server.close().then(() => process.exit(0)) })
