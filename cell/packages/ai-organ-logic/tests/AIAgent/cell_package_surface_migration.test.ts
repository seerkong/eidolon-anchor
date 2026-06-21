import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "bun:test"

const repoRoot = path.resolve(import.meta.dir, "../../../../..")

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8")
}

function collectCodeFiles(root: string): string[] {
  const results: string[] = []

  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue
      const next = path.join(current, entry.name)
      if (entry.isDirectory()) {
        visit(next)
        continue
      }
      if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
        results.push(next)
      }
    }
  }

  visit(root)
  return results
}

function collectAuditFiles(root: string): string[] {
  const results: string[] = []

  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue
      const next = path.join(current, entry.name)
      if (entry.isDirectory()) {
        visit(next)
        continue
      }
      if (entry.name === "package.json" || /\.(ts|tsx|mts|cts)$/.test(entry.name)) {
        results.push(next)
      }
    }
  }

  visit(root)
  return results
}

describe("cell package migration surface", () => {
  it("requires cell packages to expose subpath exports for migrated source layout", () => {
    const packages = [
      "platform-contract",
      "core-contract",
      "core-logic",
      "symbiont-contract",
      "symbiont-logic",
      "platform-support",
      "ai-support",
      "ai-core-contract",
      "ai-core-logic",
      "ai-organ-contract",
      "ai-organ-logic",
      "ai-composer",
      "membrane",
      "mod-platform-kernel",
      "mod-ai-kernel",
      "mod-ai-coding",
    ] as const

    for (const pkg of packages) {
      const packageJson = readJson<{ exports?: Record<string, string> }>(
        path.join(repoRoot, "cell", "packages", pkg, "package.json"),
      )

      expect(packageJson.exports).toBeDefined()
      expect(Object.prototype.hasOwnProperty.call(packageJson.exports ?? {}, "./*")).toBe(true)
    }
  })

  it("retires legacy support, legacy ai host, and mod shim packages from the workspace", () => {
    const retiredPackageDirs = [
      path.join(repoRoot, "cell", "packages", "organ-support"),
      path.join(repoRoot, "cell", "packages", "organ-contract"),
      path.join(repoRoot, "cell", "packages", "organ-logic"),
      path.join(repoRoot, "cell", "packages", "composer"),
      path.join(repoRoot, "cell", "packages", "domain-ai-contract"),
      path.join(repoRoot, "cell", "packages", "domain-ai-logic"),
      path.join(repoRoot, "cell", "packages", "domain-ai-support"),
      path.join(repoRoot, "cell", "packages", "mod-sys-kernel"),
      path.join(repoRoot, "cell", "packages", "mod-sys-coding"),
    ] as const

    for (const retiredDir of retiredPackageDirs) {
      expect(fs.existsSync(retiredDir)).toBe(false)
    }
  })

  it("forbids legacy support package imports in active code paths", () => {
    const scanRoots = [
      path.join(repoRoot, "backend"),
      path.join(repoRoot, "terminal"),
      path.join(repoRoot, "desktop"),
      path.join(repoRoot, "frontend"),
      path.join(repoRoot, "shared"),
      path.join(repoRoot, "cell"),
    ]

    const offenders: string[] = []
    const selfPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "tests", "AIAgent", "cell_package_surface_migration.test.ts")
    for (const root of scanRoots) {
      for (const filePath of collectCodeFiles(root)) {
        if (filePath === selfPath) continue
        const content = fs.readFileSync(filePath, "utf-8")
        if (!content.includes("@cell/organ-support")) continue
        offenders.push(path.relative(repoRoot, filePath))
      }
    }

    expect(offenders).toEqual([])
  })

  it("forbids legacy support/mod tsconfig aliases in workspace development paths", () => {
    const tsconfigPaths = [
      path.join(repoRoot, "cell", "tsconfig.json"),
      path.join(repoRoot, "terminal", "tsconfig.json"),
      path.join(repoRoot, "terminal", "packages", "tui", "tsconfig.json"),
      path.join(repoRoot, "backend", "tsconfig.json"),
    ]

    const forbiddenAliases = [
      "@cell/organ-support",
      "@cell/organ-support/*",
      "@cell/composer",
      "@cell/composer/*",
      "@cell/domain-ai-contract",
      "@cell/domain-ai-contract/*",
      "@cell/domain-ai-logic",
      "@cell/domain-ai-logic/*",
      "@cell/domain-ai-support",
      "@cell/domain-ai-support/*",
      "@cell/mod-sys-kernel",
      "@cell/mod-sys-kernel/*",
      "@cell/mod-sys-coding",
      "@cell/mod-sys-coding/*",
    ]

    const offenders: string[] = []

    for (const tsconfigPath of tsconfigPaths) {
      const content = readText(tsconfigPath)
      if (forbiddenAliases.some((alias) => content.includes(`"${alias}"`))) {
        offenders.push(path.relative(repoRoot, tsconfigPath))
      }
    }

    expect(offenders).toEqual([])
  })

  it("forbids legacy support/mod package imports in normal code paths", () => {
    const scanRoots = [
      path.join(repoRoot, "backend"),
      path.join(repoRoot, "terminal"),
      path.join(repoRoot, "desktop"),
      path.join(repoRoot, "frontend"),
      path.join(repoRoot, "shared"),
      path.join(repoRoot, "cell"),
    ]

    const offenders: string[] = []
    const selfPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "tests", "AIAgent", "cell_package_surface_migration.test.ts")
    const forbiddenImports = [
      "@cell/organ-support",
      "@cell/mod-sys-kernel",
      "@cell/mod-sys-coding",
    ]

    for (const root of scanRoots) {
      for (const filePath of collectCodeFiles(root)) {
        if (filePath === selfPath) continue
        const content = fs.readFileSync(filePath, "utf-8")
        if (forbiddenImports.some((entry) => content.includes(entry))) {
          offenders.push(path.relative(repoRoot, filePath))
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it("removes legacy AIAgent package exports from backend and terminal packages", () => {
    const legacyExportKeys = {
      "backend/packages/core/package.json": ["./modules/AIAgent", "./modules/AIAgent/*"],
      "backend/packages/composer/package.json": ["./modules/AIAgent/*"],
      "backend/packages/organ/package.json": [
        "./AIAgent",
        "./AIAgent/llm",
        "./AIAgent/stream",
        "./AIAgent/exec",
        "./AIAgent/mcp/McpSupport",
        "./AIAgent/skill/SkillLoader",
        "./AIAgent/plan/TodoManager",
        "./AIAgent/*",
      ],
    } as const

    for (const [relativePath, forbiddenKeys] of Object.entries(legacyExportKeys)) {
      const packageJson = readJson<{ exports?: Record<string, string> }>(path.join(repoRoot, relativePath))
      for (const key of forbiddenKeys) {
        expect(Object.prototype.hasOwnProperty.call(packageJson.exports ?? {}, key)).toBe(false)
      }
    }
  })

  it("keeps ai-composer as the real contract host after removing legacy composer", () => {
    const aiComposerContractPath = path.join(repoRoot, "cell", "packages", "ai-composer", "src", "ai-contract.ts")
    const aiComposerContent = readText(aiComposerContractPath)
    expect(aiComposerContent).toContain("@cell/ai-core-contract")
    expect(aiComposerContent).not.toContain("@cell/domain-ai-contract")
    expect(aiComposerContent).not.toContain("@cell/organ-contract/permissions/LocalPermissionConfig")
  })

  it("moves first-batch shell consumers to ai-core and ai-organ entrypoints", () => {
    const terminalRuntimePath = path.join(repoRoot, "terminal", "packages", "organ", "src", "AIAgent", "TerminalRuntime.ts")
    const terminalRuntime = readText(terminalRuntimePath)
    expect(terminalRuntime).toContain('@cell/ai-core-logic')
    expect(terminalRuntime).toContain('@cell/ai-organ-logic')
    expect(terminalRuntime).not.toContain('@cell/organ-logic')
    expect(terminalRuntime).not.toContain('AgentEventGraph')
    expect(terminalRuntime).not.toContain('MessageHistoryGraph')
    expect(terminalRuntime).not.toContain('buildRuntimeSemanticBase')
    expect(terminalRuntime).toContain('DomainRuntimeEventGraph')
    expect(terminalRuntime).toContain('DomainRuntimeHistoryGraph')
    expect(terminalRuntime).toContain('buildDomainRuntimeSemanticBase')
    expect(terminalRuntime).toContain('type DomainRuntimeVm')
    expect(terminalRuntime).not.toContain('createAiAgentOrchestratorDriverWithCooperative')
    expect(terminalRuntime).not.toContain('createVM(')
    expect(terminalRuntime).not.toContain('configureLocalPermissionConfigStore')
    expect(terminalRuntime).not.toContain('configureRuntimePersistenceSupport')
    expect(terminalRuntime).not.toContain('hasRuntimeSnapshot')
    expect(terminalRuntime).not.toContain('recoverAiAgentRuntime')
    expect(terminalRuntime).not.toContain('saveAiAgentRuntimeSnapshot')
    expect(terminalRuntime).not.toContain('getOrganizationManager')
    expect(terminalRuntime).not.toContain('getMemberManager')
    expect(terminalRuntime).not.toContain('getCoordinationEngine')
    expect(terminalRuntime).not.toContain('getDetachedActorRegistry')
    expect(terminalRuntime).toContain('createShellRuntimeFacade')
    expect(terminalRuntime).toContain('recoverOrCreateShellRuntime')

    const tuiRuntimeCatalogPath = path.join(repoRoot, "terminal", "packages", "tui", "src", "runtime", "TuiRuntimeCatalog.ts")
    const tuiRuntimeCatalog = readText(tuiRuntimeCatalogPath)
    expect(tuiRuntimeCatalog).not.toContain('@cell/ai-core-logic')
    expect(tuiRuntimeCatalog).not.toContain('@cell/ai-core-logic/config/LlmConfigLoader')
    expect(tuiRuntimeCatalog).not.toContain('resolveDomainPresetModelRef')
    expect(tuiRuntimeCatalog).toContain('@cell/ai-organ-logic/llm')
    expect(tuiRuntimeCatalog).toContain('resolvePresetModelRef')
  })

  it("keeps ai-core-logic focused on core facades after removing domain-ai-logic", () => {
    const aiCoreLogicIndexPath = path.join(repoRoot, "cell", "packages", "ai-core-logic", "src", "index.ts")
    const aiCoreLogicIndex = readText(aiCoreLogicIndexPath)
    expect(aiCoreLogicIndex).toContain("DomainRuntimeEventGraph")
    expect(aiCoreLogicIndex).toContain("DomainRuntimeHistoryGraph")
    expect(aiCoreLogicIndex).toContain("buildDomainRuntimeSemanticBase")
    expect(aiCoreLogicIndex).toContain("DomainRuntimeVm")
    expect(aiCoreLogicIndex).toContain("@cell/ai-core-contract")
    expect(aiCoreLogicIndex).not.toContain("@cell/ai-organ-logic")
    expect(aiCoreLogicIndex).not.toContain("LlmConfigLoader")
    expect(aiCoreLogicIndex).not.toContain("resolveDomainPresetModelRef")
    expect(aiCoreLogicIndex).not.toContain("createRuntimeLlmAdapter")
    expect(aiCoreLogicIndex).not.toContain("processRuntimeIngressStream")
    expect(aiCoreLogicIndex).not.toContain("emitRuntimeDirectSlashAssistantOutput")
    expect(aiCoreLogicIndex).not.toContain("DomainRuntimeDriver")
    expect(aiCoreLogicIndex).not.toContain("createShellRuntimePaths")
    expect(aiCoreLogicIndex).not.toContain("recoverOrCreateShellRuntime")
    expect(aiCoreLogicIndex).not.toContain("createActor")
    expect(aiCoreLogicIndex).not.toContain("createVM")
    expect(aiCoreLogicIndex).not.toContain("ensureAiRuntimeFacet")
    expect(aiCoreLogicIndex).not.toContain("ensureVmRuntimeContext")
    expect(aiCoreLogicIndex).not.toContain("ensureVmSessionState")
    expect(aiCoreLogicIndex).not.toContain("getAiRuntimeFacet")
    expect(aiCoreLogicIndex).not.toContain("getControlActor")
    expect(aiCoreLogicIndex).not.toContain("createAiAgentOrchestratorDriver")
    expect(aiCoreLogicIndex).not.toContain("createAiAgentOrchestratorDriverWithCooperative")
    expect(aiCoreLogicIndex).not.toContain("configureLocalPermissionConfigStore")
    expect(aiCoreLogicIndex).not.toContain("configureRuntimePersistenceSupport")
    expect(aiCoreLogicIndex).not.toContain("hasRuntimeSnapshot")
    expect(aiCoreLogicIndex).not.toContain("recoverAiAgentRuntime")
    expect(aiCoreLogicIndex).not.toContain("saveAiAgentRuntimeSnapshot")
    expect(aiCoreLogicIndex).not.toContain("tickAiAgentRuntimeBackground")
    expect(aiCoreLogicIndex).toContain("type { AiAgentVm as DomainRuntimeVm }")
  })

  it("forbids direct imports from legacy AIAgent sources", () => {
    const scanRoots = [
      path.join(repoRoot, "backend"),
      path.join(repoRoot, "terminal"),
      path.join(repoRoot, "desktop"),
      path.join(repoRoot, "frontend"),
      path.join(repoRoot, "shared"),
      path.join(repoRoot, "cell"),
    ]

    const offenders: string[] = []
    const selfPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "tests", "AIAgent", "cell_package_surface_migration.test.ts")
    for (const root of scanRoots) {
      for (const filePath of collectCodeFiles(root)) {
        if (filePath === selfPath) continue
        const content = fs.readFileSync(filePath, "utf-8")
        if (
          content.includes("@backend/core/modules/AIAgent")
          || content.includes("@backend/composer/modules/AIAgent")
          || content.includes("@backend/organ/AIAgent")
          || content.includes("@cell/composer/AIAgent")
        ) {
          offenders.push(path.relative(repoRoot, filePath))
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it("forbids legacy cell package names after symbiont refactor", () => {
    const scanRoots = [
      path.join(repoRoot, "backend"),
      path.join(repoRoot, "terminal"),
      path.join(repoRoot, "desktop"),
      path.join(repoRoot, "frontend"),
      path.join(repoRoot, "shared"),
      path.join(repoRoot, "cell"),
    ]

    const offenders: string[] = []
    const selfPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "tests", "AIAgent", "cell_package_surface_migration.test.ts")
    for (const root of scanRoots) {
      for (const filePath of collectCodeFiles(root)) {
        if (filePath === selfPath) continue
        const content = fs.readFileSync(filePath, "utf-8")
        if (
          content.includes("@cell/organ-contract-low")
          || content.includes("@cell/organ-contract-high")
        ) {
          offenders.push(path.relative(repoRoot, filePath))
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it("keeps new ai package hosts wired without legacy compatibility packages", () => {
    const terminalOrganPackageJson = readJson<{ dependencies?: Record<string, string> }>(
      path.join(repoRoot, "terminal", "packages", "organ", "package.json"),
    )
    expect(terminalOrganPackageJson.dependencies?.["@cell/ai-core-logic"]).toBe("workspace:*")

    const terminalTuiPackageJson = readJson<{ dependencies?: Record<string, string> }>(
      path.join(repoRoot, "terminal", "packages", "tui", "package.json"),
    )
    expect(terminalTuiPackageJson.dependencies?.["@cell/ai-core-logic"]).toBe("workspace:*")

    const aiCoreLogicPackageJson = readJson<{ dependencies?: Record<string, string> }>(
      path.join(repoRoot, "cell", "packages", "ai-core-logic", "package.json"),
    )
    expect(aiCoreLogicPackageJson.dependencies?.["@cell/ai-core-contract"]).toBe("workspace:*")
  })

  it("limits legacy ai package names to migration guards only", () => {
    const legacyImports = [
      "@cell/composer",
      "@cell/domain-ai-contract",
      "@cell/domain-ai-logic",
      "@cell/domain-ai-support",
    ]

    const allowedRelativePaths = new Set([
      "cell/packages/ai-organ-logic/tests/AIAgent/cell_package_surface_migration.test.ts",
    ])

    const scanRoots = [
      path.join(repoRoot, "backend"),
      path.join(repoRoot, "terminal"),
      path.join(repoRoot, "desktop"),
      path.join(repoRoot, "frontend"),
      path.join(repoRoot, "shared"),
      path.join(repoRoot, "cell"),
    ]

    const offenders: string[] = []
    for (const root of scanRoots) {
      for (const filePath of collectAuditFiles(root)) {
        const relativePath = path.relative(repoRoot, filePath)
        if (allowedRelativePaths.has(relativePath)) continue
        const content = fs.readFileSync(filePath, "utf-8")
        if (legacyImports.some((entry) => content.includes(entry))) {
          offenders.push(relativePath)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it("removes active imports of legacy core AI hosts", () => {
    const forbiddenImports = [
      "@cell/core-contract",
      "@cell/core-logic",
    ]

    const allowedRelativePaths = new Set([
      "cell/packages/ai-organ-logic/tests/AIAgent/cell_package_surface_migration.test.ts",
    ])

    const scanRoots = [
      path.join(repoRoot, "backend"),
      path.join(repoRoot, "terminal"),
      path.join(repoRoot, "desktop"),
      path.join(repoRoot, "frontend"),
      path.join(repoRoot, "shared"),
      path.join(repoRoot, "cell"),
    ]

    const offenders: string[] = []
    for (const root of scanRoots) {
      for (const filePath of collectAuditFiles(root)) {
        const relativePath = path.relative(repoRoot, filePath)
        if (allowedRelativePaths.has(relativePath)) continue
        if (relativePath.startsWith("cell/packages/core-contract/")) continue
        if (relativePath.startsWith("cell/packages/core-logic/")) continue
        const content = fs.readFileSync(filePath, "utf-8")
        if (forbiddenImports.some((entry) => content.includes(entry))) {
          offenders.push(relativePath)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it("makes membrane a higher-level facade that references ai-composer", () => {
    const membranePackageJson = readJson<{ dependencies?: Record<string, string> }>(
      path.join(repoRoot, "cell", "packages", "membrane", "package.json"),
    )
    expect(membranePackageJson.dependencies?.["@cell/ai-composer"]).toBe("workspace:*")

    const membraneIndexPath = path.join(repoRoot, "cell", "packages", "membrane", "src", "index.ts")
    const membraneIndex = readText(membraneIndexPath)
    expect(membraneIndex).toContain("@cell/ai-composer")

    const membraneRuntimeCompositionPath = path.join(repoRoot, "cell", "packages", "membrane", "src", "runtime-composition.ts")
    const membraneRuntimeComposition = readText(membraneRuntimeCompositionPath)
    expect(membraneRuntimeComposition).toContain("@cell/ai-composer")
    expect(membraneRuntimeComposition).toContain("createRuntimeCompositionFacade")
    expect(membraneRuntimeComposition).toContain("assembleRuntimeCompositionProfile")

    const aiCoreLogicPackageJson = readJson<{ dependencies?: Record<string, string> }>(
      path.join(repoRoot, "cell", "packages", "ai-core-logic", "package.json"),
    )
    expect(aiCoreLogicPackageJson.dependencies?.["@cell/ai-composer"]).toBeUndefined()

    const aiCoreLogicIndex = readText(path.join(repoRoot, "cell", "packages", "ai-core-logic", "src", "index.ts"))
    expect(aiCoreLogicIndex).not.toContain("@cell/ai-composer")
  })

  it("moves core AI runtime consumers onto ai-* ownership hosts", () => {
    const modAiKernelIndexPath = path.join(repoRoot, "cell", "packages", "mod-ai-kernel", "src", "index.ts")
    const modAiKernelIndex = readText(modAiKernelIndexPath)
    expect(modAiKernelIndex).toContain("@cell/ai-core-contract")
    expect(modAiKernelIndex).toContain("@cell/ai-support")
    expect(modAiKernelIndex).toContain("@cell/ai-organ-logic/composer/AIAgent")
    expect(modAiKernelIndex).not.toContain("@cell/domain-ai-contract")
    expect(modAiKernelIndex).not.toContain("@cell/domain-ai-support")

    const modProfilesIndexPath = path.join(repoRoot, "cell", "packages", "mod-profiles", "src", "index.ts")
    const modProfilesIndex = readText(modProfilesIndexPath)
    expect(modProfilesIndex).toContain("@cell/ai-composer")
    expect(modProfilesIndex).not.toContain("@cell/composer")

    const terminalCoreSlashCommandsPath = path.join(repoRoot, "terminal", "packages", "core", "src", "AIAgent", "SlashCommands.ts")
    const terminalCoreSlashCommands = readText(terminalCoreSlashCommandsPath)
    expect(terminalCoreSlashCommands).toContain("@cell/ai-core-contract")
    expect(terminalCoreSlashCommands).not.toContain("@cell/domain-ai-contract")

    const terminalOrganPackageJson = readJson<{ dependencies?: Record<string, string> }>(
      path.join(repoRoot, "terminal", "packages", "organ", "package.json"),
    )
    expect(terminalOrganPackageJson.dependencies?.["@cell/membrane"]).toBe("workspace:*")
    expect(terminalOrganPackageJson.dependencies?.["@cell/composer"]).toBeUndefined()

    const terminalRuntimePath = path.join(repoRoot, "terminal", "packages", "organ", "src", "AIAgent", "TerminalRuntime.ts")
    const terminalRuntime = readText(terminalRuntimePath)
    expect(terminalRuntime).toContain("@cell/membrane/runtime-composition")
    expect(terminalRuntime).not.toContain("@cell/composer/ai-contract")
    expect(terminalRuntime).toContain("assembleRuntimeCompositionProfile")

    const terminalCoreSlashCommandPath = path.join(repoRoot, "terminal", "packages", "core", "src", "AIAgent", "SlashCommands.ts")
    const terminalCoreSlashCommand = readText(terminalCoreSlashCommandPath)
    expect(terminalCoreSlashCommand).toContain("@cell/ai-core-contract")
    expect(terminalCoreSlashCommand).not.toContain("@cell/membrane")

    const terminalTuiCatalogPath = path.join(repoRoot, "terminal", "packages", "tui", "src", "runtime", "TuiRuntimeCatalog.ts")
    const terminalTuiCatalog = readText(terminalTuiCatalogPath)
    expect(terminalTuiCatalog).not.toContain("@cell/ai-core-logic")
    expect(terminalTuiCatalog).toContain("@cell/ai-organ-logic/llm")
    expect(terminalTuiCatalog).not.toContain("@cell/composer")
    expect(terminalTuiCatalog).not.toContain("@cell/ai-composer")

    const terminalOrganSupportPath = path.join(repoRoot, "terminal", "packages", "organ-support", "src", "exec.ts")
    const terminalOrganSupport = readText(terminalOrganSupportPath)
    expect(terminalOrganSupport).not.toContain("@cell/composer")
    expect(terminalOrganSupport).not.toContain("@cell/membrane")
  })

  it("keeps ai-organ-logic layered above ai-core-logic", () => {
    const aiCoreLogicIndexPath = path.join(repoRoot, "cell", "packages", "ai-core-logic", "src", "index.ts")
    const aiCoreLogicIndex = readText(aiCoreLogicIndexPath)
    expect(aiCoreLogicIndex).not.toContain("@cell/ai-organ-logic")

    const aiCoreLogicPackageJson = readJson<{ dependencies?: Record<string, string> }>(
      path.join(repoRoot, "cell", "packages", "ai-core-logic", "package.json"),
    )
    expect(aiCoreLogicPackageJson.dependencies?.["@cell/ai-organ-logic"]).toBeUndefined()

    const aiOrganLogicPackageJson = readJson<{ dependencies?: Record<string, string> }>(
      path.join(repoRoot, "cell", "packages", "ai-organ-logic", "package.json"),
    )
    expect(aiOrganLogicPackageJson.dependencies?.["@cell/ai-core-logic"]).toBe("workspace:*")

    const aiSupportPackageJson = readJson<{ dependencies?: Record<string, string> }>(
      path.join(repoRoot, "cell", "packages", "ai-support", "package.json"),
    )
    expect(aiSupportPackageJson.dependencies?.["@cell/ai-organ-contract"]).toBe("workspace:*")
    expect(aiSupportPackageJson.dependencies?.["@cell/ai-organ-logic"]).toBe("workspace:*")

    const aiSupportPermissionPath = path.join(repoRoot, "cell", "packages", "ai-support", "src", "permissions", "LocalFilePermissionConfigStore.ts")
    const aiSupportPermission = readText(aiSupportPermissionPath)
    expect(aiSupportPermission).toContain("@cell/ai-organ-contract/permissions/LocalPermissionConfig")
    expect(aiSupportPermission).toContain("@cell/ai-organ-logic/permissions/LocalPermissionConfig")
    expect(aiSupportPermission).not.toContain("@cell/organ-contract/permissions/LocalPermissionConfig")
  })

  it("makes ai-organ hosts the real source owners and deletes legacy organ packages", () => {
    const aiOrganLogicIndexPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "index.ts")
    const aiOrganLogicIndex = readText(aiOrganLogicIndexPath)
    expect(aiOrganLogicIndex).toContain('./OrchestratorDriver')
    expect(aiOrganLogicIndex).toContain('./persistence/RuntimeSnapshots')
    expect(aiOrganLogicIndex).toContain('./permissions/LocalPermissionConfig')
    expect(aiOrganLogicIndex).toContain('./agent/DelegateActor')
    expect(aiOrganLogicIndex).toContain('./stream')
    expect(aiOrganLogicIndex).not.toContain('@cell/organ-logic')

    const aiOrganContractIndexPath = path.join(repoRoot, "cell", "packages", "ai-organ-contract", "src", "index.ts")
    const aiOrganContractIndex = readText(aiOrganContractIndexPath)
    expect(aiOrganContractIndex).toContain("./permissions/LocalPermissionConfig")
    expect(aiOrganContractIndex).not.toContain('@cell/organ-contract')
    expect(fs.existsSync(path.join(repoRoot, "cell", "packages", "organ-contract"))).toBe(false)
    expect(fs.existsSync(path.join(repoRoot, "cell", "packages", "organ-logic"))).toBe(false)

    const aiOrganPermissionContractPath = path.join(repoRoot, "cell", "packages", "ai-organ-contract", "src", "permissions", "LocalPermissionConfig.ts")
    const aiOrganPermissionContract = readText(aiOrganPermissionContractPath)
    expect(aiOrganPermissionContract).toContain("export type LocalPermissionAction")
    expect(aiOrganPermissionContract).not.toContain('@cell/organ-contract')

    const aiOrganDelegateActorPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "agent", "DelegateActor.ts")
    const aiOrganDelegateActor = readText(aiOrganDelegateActorPath)
    expect(aiOrganDelegateActor).toContain("export async function spawnChildExecutionActor")
    expect(aiOrganDelegateActor).toContain("@cell/ai-organ-contract/agent/DelegateRunMode")
    expect(aiOrganDelegateActor).not.toContain('@cell/organ-contract/agent/DelegateRunMode')

    const aiOrganPermissionLogicPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "permissions", "LocalPermissionConfig.ts")
    const aiOrganPermissionLogic = readText(aiOrganPermissionLogicPath)
    expect(aiOrganPermissionLogic).toContain("configureLocalPermissionConfigStore")
    expect(aiOrganPermissionLogic).toContain("@cell/ai-organ-contract/permissions/LocalPermissionConfig")
    expect(aiOrganPermissionLogic).not.toContain('@cell/organ-contract/permissions/LocalPermissionConfig')

    const aiOrganToolComposerPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "composer", "AIAgent", "ToolFuncComposer.ts")
    const aiOrganToolComposer = readText(aiOrganToolComposerPath)
    expect(aiOrganToolComposer).toContain("export function composeToolRegistry")

    const aiOrganLlmEntryPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "llm.ts")
    const aiOrganLlmEntry = readText(aiOrganLlmEntryPath)
    expect(aiOrganLlmEntry.trim()).toBe('export * from "./llm/index";')

    const aiOrganLlmIndexPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "llm", "index.ts")
    const aiOrganLlmIndex = readText(aiOrganLlmIndexPath)
    expect(aiOrganLlmIndex).toContain("OpenAIResponsesNodejsFetchLlmAdapter")

    const aiOrganMcpSupportPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "mcp", "McpSupport.ts")
    const aiOrganMcpSupport = readText(aiOrganMcpSupportPath)
    expect(aiOrganMcpSupport).toContain("export class StdioTransport")
    expect(aiOrganMcpSupport).not.toContain('@cell/organ-logic')

    const aiOrganCoordinationEnginePath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "coordination", "CoordinationEngine.ts")
    const aiOrganCoordinationEngine = readText(aiOrganCoordinationEnginePath)
    expect(aiOrganCoordinationEngine).toContain("export class CoordinationEngine")
    expect(aiOrganCoordinationEngine).not.toContain('@cell/organ-logic/coordination/CoordinationEngine')

    const aiOrganMemberManagerPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "organization", "MemberManager.ts")
    const aiOrganMemberManager = readText(aiOrganMemberManagerPath)
    expect(aiOrganMemberManager).toContain("export class MemberManager")
    expect(aiOrganMemberManager).toContain("@cell/ai-organ-contract/organization/MemberRole")
    expect(aiOrganMemberManager).not.toContain('@cell/organ-contract/organization/MemberRole')

    const aiOrganOrganizationManagerPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "organization", "OrganizationManager.ts")
    const aiOrganOrganizationManager = readText(aiOrganOrganizationManagerPath)
    expect(aiOrganOrganizationManager).toContain("export class OrganizationManager")
    expect(aiOrganOrganizationManager).not.toContain('@cell/organ-logic/organization/OrganizationManager')

    const aiOrganRuntimeCoordinatorPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "runtime", "AiAgentRuntimeCoordinator.ts")
    const aiOrganRuntimeCoordinator = readText(aiOrganRuntimeCoordinatorPath)
    expect(aiOrganRuntimeCoordinator).toContain("export function createAiAgentRuntimeCoordinator")
    expect(aiOrganRuntimeCoordinator).toContain("./tickAiAgentRuntimeBackground")
    expect(aiOrganRuntimeCoordinator).not.toContain('@cell/organ-logic/runtime/AiAgentRuntimeCoordinator')

    const aiOrganRuntimeTickPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "runtime", "tickAiAgentRuntimeBackground.ts")
    const aiOrganRuntimeTick = readText(aiOrganRuntimeTickPath)
    expect(aiOrganRuntimeTick).toContain("export async function tickAiAgentRuntimeBackground")

    // The orchestrator driver implementation now lives inside the capsule;
    // OrchestratorDriver.ts remains the compatibility facade.
    const aiOrganOrchestratorDriverPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "orchestratorCapsule", "internals", "driverRuntime.ts")
    const aiOrganOrchestratorDriver = readText(aiOrganOrchestratorDriverPath)
    expect(aiOrganOrchestratorDriver).toContain("export function createAiAgentOrchestratorDriver")
    expect(aiOrganOrchestratorDriver).toContain("@cell/ai-organ-contract/agent/DelegateRunMode")
    expect(aiOrganOrchestratorDriver).toContain('./exec/AiAgentExecutor')
    expect(aiOrganOrchestratorDriver).not.toContain('@cell/organ-contract/agent/DelegateRunMode')
    expect(aiOrganOrchestratorDriver).not.toContain('@cell/organ-logic/exec/AiAgentExecutor')

    const aiOrganOrchestratorFacadePath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "OrchestratorDriver.ts")
    const aiOrganOrchestratorFacade = readText(aiOrganOrchestratorFacadePath)
    expect(aiOrganOrchestratorFacade).toContain("createAiAgentOrchestratorDriver")
    expect(aiOrganOrchestratorFacade).toContain("@cell/ai-organ-contract/agent/DelegateRunMode")
    expect(aiOrganOrchestratorFacade).not.toContain('@cell/organ-contract/agent/DelegateRunMode')

    const aiOrganDetachedRegistryPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "detached", "DetachedActorRegistry.ts")
    const aiOrganDetachedRegistry = readText(aiOrganDetachedRegistryPath)
    expect(aiOrganDetachedRegistry).toContain("export class DetachedActorRegistry")
    expect(aiOrganDetachedRegistry).not.toContain('@cell/organ-logic/detached/DetachedActorRegistry')

    const aiOrganLanePath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "lane", "AiAgentLane.ts")
    const aiOrganLane = readText(aiOrganLanePath)
    expect(aiOrganLane).toContain("export const AI_AGENT_LANES")
    expect(aiOrganLane).toContain("@cell/ai-organ-contract/agent/DelegateRunMode")
    expect(aiOrganLane).not.toContain('@cell/organ-contract/agent/DelegateRunMode')

    const aiOrganWorkloadPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "lane", "AiAgentWorkload.ts")
    const aiOrganWorkload = readText(aiOrganWorkloadPath)
    expect(aiOrganWorkload).toContain("export const AI_AGENT_WORKLOADS")
    expect(aiOrganWorkload).toContain("../detached/DetachedActorRegistry")
    expect(aiOrganWorkload).toContain("@cell/ai-organ-contract/agent/DelegateRunMode")

    const aiOrganExecutorPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "exec", "AiAgentExecutor.ts")
    const aiOrganExecutor = readText(aiOrganExecutorPath)
    expect(aiOrganExecutor).toContain("function aiAgentLoopStreaming")
    expect(aiOrganExecutor).toContain("../coordination/CoordinationEngine")
    expect(aiOrganExecutor).toContain("@cell/ai-organ-contract/agent/DelegateRunMode")
    expect(aiOrganExecutor).not.toContain('@cell/organ-contract/agent/DelegateRunMode')
    expect(aiOrganExecutor).not.toContain('@cell/organ-logic')

    const aiOrganRuntimeSnapshotsPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "src", "persistence", "RuntimeSnapshots.ts")
    const aiOrganRuntimeSnapshots = readText(aiOrganRuntimeSnapshotsPath)
    expect(aiOrganRuntimeSnapshots).toContain("export function configureRuntimePersistenceSupport")
    expect(aiOrganRuntimeSnapshots).toContain("../exec/AiAgentExecutor")
    expect(aiOrganRuntimeSnapshots).toContain("../OrchestratorDriver")
    expect(aiOrganRuntimeSnapshots).toContain("@cell/ai-organ-contract/persistence/RuntimeDerivedIndexes")
    expect(aiOrganRuntimeSnapshots).not.toContain('@cell/organ-contract/persistence/RuntimeDerivedIndexes')
  })

  it("leaves core-contract and core-logic without AI-specific source trees", () => {
    const coreContractSrc = path.join(repoRoot, "cell", "packages", "core-contract", "src")
    const coreLogicSrc = path.join(repoRoot, "cell", "packages", "core-logic", "src")

    expect(fs.readdirSync(coreContractSrc).sort()).toEqual(["index.ts"])
    expect(fs.readdirSync(coreLogicSrc).sort()).toEqual(["index.ts"])
    expect(readText(path.join(coreContractSrc, "index.ts")).trim()).toBe("export {}")
    expect(readText(path.join(coreLogicSrc, "index.ts")).trim()).toBe("export {}")
  })

  it("keeps platform-logic behind the evidence gate", () => {
    const platformLogicDir = path.join(repoRoot, "cell", "packages", "platform-logic")
    expect(fs.existsSync(platformLogicDir)).toBe(false)

    const scanRoots = [
      path.join(repoRoot, "backend"),
      path.join(repoRoot, "terminal"),
      path.join(repoRoot, "desktop"),
      path.join(repoRoot, "frontend"),
      path.join(repoRoot, "shared"),
      path.join(repoRoot, "cell"),
    ]

    const offenders: string[] = []
    const selfPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "tests", "AIAgent", "cell_package_surface_migration.test.ts")
    for (const root of scanRoots) {
      for (const filePath of collectCodeFiles(root)) {
        if (filePath === selfPath) continue
        const content = fs.readFileSync(filePath, "utf-8")
        if (content.includes("@cell/platform-logic")) {
          offenders.push(path.relative(repoRoot, filePath))
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it("keeps platform packages free of domain-ai import leakage", () => {
    const platformRoots = [
      path.join(repoRoot, "cell", "packages", "platform-contract"),
      path.join(repoRoot, "cell", "packages", "platform-support"),
      path.join(repoRoot, "cell", "packages", "mod-platform-kernel"),
    ]

    const offenders: string[] = []
    for (const root of platformRoots) {
      for (const filePath of collectCodeFiles(root)) {
        const content = fs.readFileSync(filePath, "utf-8")
        if (
          content.includes("@cell/composer/ai-contract")
          || content.includes("@cell/domain-ai-")
          || content.includes("@cell/organ-contract")
          || content.includes("@cell/organ-logic")
        ) {
          offenders.push(path.relative(repoRoot, filePath))
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it("does not introduce platform-logic before the evidence gate is satisfied", () => {
    const packageDir = path.join(repoRoot, "cell", "packages", "platform-logic")
    expect(fs.existsSync(packageDir)).toBe(false)

    const tsconfigPaths = [
      path.join(repoRoot, "cell", "tsconfig.json"),
      path.join(repoRoot, "terminal", "tsconfig.json"),
      path.join(repoRoot, "terminal", "packages", "tui", "tsconfig.json"),
      path.join(repoRoot, "backend", "tsconfig.json"),
    ]

    for (const tsconfigPath of tsconfigPaths) {
      const content = readText(tsconfigPath)
      expect(content.includes('"@cell/platform-logic"')).toBe(false)
      expect(content.includes('"@cell/platform-logic/*"')).toBe(false)
    }

    const scanRoots = [
      path.join(repoRoot, "backend"),
      path.join(repoRoot, "terminal"),
      path.join(repoRoot, "desktop"),
      path.join(repoRoot, "frontend"),
      path.join(repoRoot, "shared"),
      path.join(repoRoot, "cell"),
    ]

    const offenders: string[] = []
    const selfPath = path.join(repoRoot, "cell", "packages", "ai-organ-logic", "tests", "AIAgent", "cell_package_surface_migration.test.ts")
    for (const root of scanRoots) {
      for (const filePath of collectCodeFiles(root)) {
        if (filePath === selfPath) continue
        const content = fs.readFileSync(filePath, "utf-8")
        if (content.includes("@cell/platform-logic")) {
          offenders.push(path.relative(repoRoot, filePath))
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
