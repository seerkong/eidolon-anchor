import path from "node:path"
import type { CommandModule } from "yargs"
import type { HostAuthorizationEffects } from "@cell/ai-runtime-host-contract"

export type ServeArgs = { project?: string; host: string; port: number; credentialFile?: string; globalRoot?: string; hostStateDir?: string; adapter?: string; model?: string; mcp: boolean }

export const serve: CommandModule<object, ServeArgs> = {
  command: "serve [project]",
  describe: "serve the authenticated Anchor runtime on loopback without starting the TUI",
  builder: command => command
    .positional("project", { type: "string", describe: "project directory" })
    .option("host", { type: "string", default: "127.0.0.1" })
    .option("port", { type: "number", default: 4001 })
    .option("credential-file", { type: "string", describe: "owner-private bearer file (default: project/.anchor/serve-token)" })
    .option("global-root", { type: "string" })
    .option("host-state-dir", { type: "string" })
    .option("adapter", { type: "string", describe: "provider adapter override" })
    .option("model", { type: "string", describe: "provider/model override" })
    .option("mcp", { type: "boolean", default: true }),
  handler: async args => {
    // This CLI profile is deliberately local. Remote deployments inject their authentication and scopes into serveRuntime.
    if (!["127.0.0.1", "::1", "localhost"].includes(args.host)) throw new Error("Remote serving requires an embedding with TLS, principals and explicit scopes")
    if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error("Invalid listen port")
    const { serveRuntime, bearerAuthentication, loadOrCreateBearer } = await import("@backend/elysia-shell/runtime-serve")
    const workDir = path.resolve(process.env.PWD ?? process.cwd(), args.project ?? ".")
    const credentialFile = path.resolve(workDir, args.credentialFile ?? ".anchor/serve-token")
    const token = await loadOrCreateBearer(credentialFile)
    const principal = { principalId: "local-owner", grantsVersion: "1" }
    const authorization: HostAuthorizationEffects = {
      permits: caller => caller.principalId === principal.principalId && caller.grantsVersion === principal.grantsVersion,
      currentGrantsVersion: id => id === principal.principalId ? principal.grantsVersion : undefined,
    }
    const host = await serveRuntime({
      host: { workDir, authorization, allowedProfiles: ["ai-coding"], globalRoot: args.globalRoot ? path.resolve(args.globalRoot) : undefined, hostStateDir: args.hostStateDir ? path.resolve(args.hostStateDir) : undefined, runtimeConfig: { adapter: args.adapter, model: args.model, mcp: args.mcp } },
      listen: { hostname: args.host, port: args.port },
      security: { authenticate: bearerAuthentication(token, principal) },
    })
    process.stdout.write(`ANCHOR_READY ${host.address}\n`)
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      void host.close().then(() => { process.exitCode = 0 }, () => { process.stderr.write("Anchor shutdown failed\n"); process.exitCode = 1 })
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  },
}
