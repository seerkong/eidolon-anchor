import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { AI_RUNTIME_CONTROL_BOUNDARY_DECLARATIONS } from "../src"

/**
 * Encapsulation conformance: every declared core logic entry must exist in its
 * cluster's sources and must not reach IO directly. IO belongs behind the
 * injected effect contracts; the outer adapter surface owns framework wiring.
 */

const packagesRoot = path.resolve(import.meta.dir, "../..")

/** Source files per cluster, relative to cell/packages. */
const CLUSTER_SOURCES: Record<string, string[]> = {
  orchestrator_driver: ["ai-organ-logic/src/orchestratorCapsule/internals/decisions.ts"],
  runtime_control_engine: [
    "ai-runtime-control-logic/src/engineCapsule/coreLogic.ts",
    "ai-runtime-control-logic/src/index.ts",
    "ai-runtime-control-logic/src/recoveryScanner.ts",
  ],
  snapshot_coordinator: [
    "ai-runtime-control-composer/src/coordinatorCapsule/coreLogic.ts",
    "ai-runtime-control-composer/src/index.ts",
  ],
}

type ExtractedFunction = {
  file: string
  source: string
}

function readClusterSources(componentId: string): Array<{ file: string; content: string }> {
  const files = CLUSTER_SOURCES[componentId]
  expect(files, `cluster ${componentId} must map to source files`).toBeDefined()
  return files.map((file) => ({
    file,
    content: fs.readFileSync(path.join(packagesRoot, file), "utf8"),
  }))
}

/**
 * Extracts a top-level function body by name: from its declaration line to the
 * next top-level declaration. Works for both `function name(` and
 * `export function name(` (sync or async).
 */
function extractFunctionSource(content: string, name: string): string | null {
  const declaration = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m")
  const match = declaration.exec(content)
  if (!match) return null
  const start = match.index
  const rest = content.slice(start + match[0].length)
  const next = /^(?:export )?(?:async )?(?:function|const|class|type|interface)\s/m.exec(rest)
  const end = next ? start + match[0].length + next.index : content.length
  return content.slice(start, end)
}

function findDeclaredFunction(componentId: string, name: string): ExtractedFunction | null {
  for (const { file, content } of readClusterSources(componentId)) {
    const source = extractFunctionSource(content, name)
    if (source) return { file, source }
  }
  return null
}

describe("control core logic entries exist and stay IO-free", () => {
  for (const declaration of AI_RUNTIME_CONTROL_BOUNDARY_DECLARATIONS) {
    for (const entry of declaration.coreLogicEntries) {
      it(`${declaration.id}/${entry} is a real symbol without direct IO`, () => {
        const found = findDeclaredFunction(declaration.id, entry)
        expect(found, `declared core logic entry ${entry} must exist in ${declaration.id} sources`).not.toBeNull()
        const violations = declaration.forbiddenDirectIo.filter((pattern) => found!.source.includes(pattern))
        expect(violations).toEqual([])
      })
    }
  }
})

describe("control core logic modules do not import IO directly", () => {
  it("the runtime control engine package has no direct IO imports", () => {
    for (const { file, content } of readClusterSources("runtime_control_engine")) {
      const imports = content.match(/^import .*$/gm) ?? []
      const ioImports = imports.filter((line) => /node:fs|node:child_process|node:net|node:http/.test(line))
      expect(ioImports, `${file} must not import IO modules`).toEqual([])
    }
  })
})

/**
 * Spec case reuse-vendor-adapter: outer/inner layering reuses the
 * depa-processor std adapter primitives; no parallel encapsulation framework
 * is built in the control plane. The full migration of the three clusters onto
 * adapter call chains is owned by the follow-up restructuring track
 * (decisions.md decision 2); what is asserted here is the standing constraint:
 * the vendor primitives stay the single adapter implementation.
 */
describe("conformance: encapsulation reuses the depa-processor adapter", () => {
  const CONTROL_PLANE_SOURCE_DIRS = [
    "platform-contract/src",
    "ai-runtime-control-contract/src",
    "ai-runtime-control-logic/src",
    "ai-runtime-control-composer/src",
    "ai-organ-logic/src/orchestratorCapsule",
  ]
  const CONTROL_PLANE_EXTRA_FILES = [
    "ai-organ-logic/src/OrchestratorDriver.ts",
    "ai-organ-logic/src/persistence/RuntimeSnapshots.ts",
  ]
  /** A local definition (not an import) of the vendor adapter primitives. */
  const PARALLEL_ADAPTER_DEFINITION =
    /(?:^|\s)(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+)(runBy\w*Adapter|stdMake\w+)\b/

  function listTypescriptFiles(dir: string): string[] {
    const absolute = path.join(packagesRoot, dir)
    if (!fs.existsSync(absolute)) return []
    const collected: string[] = []
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relative = path.join(dir, entry.name)
      if (entry.isDirectory()) collected.push(...listTypescriptFiles(relative))
      else if (entry.name.endsWith(".ts")) collected.push(relative)
    }
    return collected
  }

  it("control-plane sources do not define a parallel adapter framework", () => {
    const files = [
      ...CONTROL_PLANE_SOURCE_DIRS.flatMap((dir) => listTypescriptFiles(dir)),
      ...CONTROL_PLANE_EXTRA_FILES,
    ]
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const content = fs.readFileSync(path.join(packagesRoot, file), "utf8")
      const definition = PARALLEL_ADAPTER_DEFINITION.exec(content)
      expect(
        definition,
        `${file} must not define ${definition?.[1] ?? "an adapter primitive"} locally; reuse depa-processor`,
      ).toBeNull()
    }
  })

  it("the std adapter primitives in use come from depa-processor (house style template)", () => {
    const houseStyle = fs.readFileSync(
      path.join(packagesRoot, "ai-core-logic/src/runtime/ToolFuncRegistry.ts"),
      "utf8",
    )
    expect(houseStyle).toContain("runByFuncStyleAdapter")
    expect(houseStyle).toMatch(/from\s+"depa-processor"/)
  })
})
