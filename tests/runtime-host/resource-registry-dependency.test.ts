import { expect, test } from "bun:test"
import { readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const consumer = path.join(root, "cell/packages/ai-organ-logic")
const workflow = realpathSync(Bun.resolveSync("ai-workflow-logic", consumer))
const resourceCore = (from: string) => realpathSync(Bun.resolveSync("halfcode-compiler.xnl/resource-core", from))

test("Anchor and workflow share the pinned Halfcode resource provenance owner", async () => {
  const direct = resourceCore(consumer)
  const indirect = resourceCore(path.dirname(workflow))
  expect(indirect).toBe(direct)
  const installed = JSON.parse(readFileSync(path.resolve(path.dirname(direct), "../package.json"), "utf8"))
  const declared = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  expect(installed.version).toBe(declared.overrides["halfcode-compiler.xnl"])

  const creator = await import(direct)
  const validator = await import(indirect)
  const registry = creator.composeLayeredResourceRegistry({ layers: [] })
  expect(() => validator.resolveEffectiveResourceContentIdentities({ registry, layers: [] })).not.toThrow()
  expect(() => validator.resolveEffectiveResourceContentIdentities({ registry: {}, layers: [] })).toThrow()
})
