import path from "node:path"

import { FILE_XNL_HOLON_E2E_RESOURCE_CONFIG } from "./fileXnlHolonE2eScenario"
import {
  createNodeFileXnlHolonE2eResourceRuntime,
  materializeFileXnlHolonE2eResource,
} from "./materializeFileXnlHolonE2eResource"

function outputArgument(args: readonly string[]): string {
  const outputIndex = args.indexOf("--output")
  const value = outputIndex >= 0 ? args[outputIndex + 1] : undefined
  if (!value || args.length !== 2 || outputIndex !== 0) {
    throw new Error("Usage: bun run generateFileXnlHolonE2eResource.ts --output <empty-absolute-directory>")
  }
  if (!path.isAbsolute(value)) throw new Error("HOLON_E2E_OUTPUT_ROOT_NOT_ABSOLUTE")
  return value
}

export async function runGenerateFileXnlHolonE2eResource(args: readonly string[]): Promise<void> {
  const result = await materializeFileXnlHolonE2eResource(
    createNodeFileXnlHolonE2eResourceRuntime(),
    { outputRoot: outputArgument(args) },
    FILE_XNL_HOLON_E2E_RESOURCE_CONFIG,
  )
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (import.meta.main) {
  await runGenerateFileXnlHolonE2eResource(process.argv.slice(2))
}
