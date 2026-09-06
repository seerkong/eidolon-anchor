import { render } from "@opentui/solid"
import { createSyntheticSource } from "./source"
import { ScrollPrototype } from "./view"

const args = Bun.argv.slice(2)
const argument = (name: string, fallback: string) => args.find(value => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback
const shape = argument("shape", "log")
if (shape !== "log" && shape !== "chat") throw new Error("--shape must be log or chat")
const source = createSyntheticSource({
  identity: { sourceId: "standalone", actorId: "demo", sourceEpoch: 1, generation: 1 },
  count: Number(argument("count", "10000")), shape, tailLines: Number(argument("tail-lines", "2")),
})
await render(() => <ScrollPrototype source={source} />, { exitOnCtrlC: true })
