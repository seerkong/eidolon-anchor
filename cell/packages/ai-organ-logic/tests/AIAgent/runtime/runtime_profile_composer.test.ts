import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "bun:test"

import {
  assemblePlatformProfile,
  assembleRuntimeProfile,
} from "@cell/ai-composer"
import type {
  RuntimeAssemblyContext as PlatformRuntimeAssemblyContext,
  RuntimeAssemblyState as PlatformRuntimeAssemblyState,
  RuntimeExtension as PlatformRuntimeExtension,
} from "@cell/ai-composer/contract"
import type { RuntimeExtension } from "@cell/ai-composer/ai-contract"
import {
  createPlatformRuntimeRegistries,
  findNearestProjectRoot,
  resolveProjectWorkDir,
} from "../../../../platform-support/src/index"
import { AgentRegistry, SkillRegistry, ToolFuncRegistry } from "@cell/ai-core-logic"
import { loadAgentsFromDir } from "../../../../ai-support/src/agent/LocalFileAgentLoader"
import { applyModPlatformKernel } from "../../../../mod-platform-kernel/src/index"
import {
  aiCodingRuntimeProfile,
  aiKernelRuntimeProfile,
  assembleAiCodingRuntimeProfile,
  assembleAiKernelRuntimeProfile,
  assemblePlatformOnlyRuntimeProfile,
  platformOnlyRuntimeProfile,
} from "../../../../mod-profiles/src/index"

describe("runtime profile composer", () => {
  it("exposes a platform-level composer contract without AI-only context fields", () => {
    const context: PlatformRuntimeAssemblyContext = {
      workDir: "/tmp/platform-profile",
    }
    const extension: PlatformRuntimeExtension = {
      id: "platform-overlay",
      apply(state, nextContext) {
        expect(nextContext.workDir).toBe("/tmp/platform-profile")
        return {
          ...state,
          systemPromptSections: [...state.systemPromptSections, "platform"],
          capabilityIds: [...state.capabilityIds, "platform-overlay"],
          policies: {
            ...state.policies,
            platformOverlayOwner: "platform-overlay",
          },
        }
      },
    }
    const initialState: PlatformRuntimeAssemblyState = {
      systemPromptSections: [],
      capabilityIds: [],
      policies: {},
    }

    const next = extension.apply(initialState, context)

    expect(next.systemPromptSections).toEqual(["platform"])
    expect(next.capabilityIds).toEqual(["platform-overlay"])
    expect(next.policies.platformOverlayOwner).toBe("platform-overlay")
  })

  it("assembles a platform-only profile through the platform-first root composer", () => {
    const context: PlatformRuntimeAssemblyContext = {
      workDir: "/tmp/platform-profile",
    }
    const profile = {
      id: "platform-profile",
      extensions: [
        {
          id: "platform-overlay",
          apply(state: PlatformRuntimeAssemblyState, nextContext: PlatformRuntimeAssemblyContext) {
            return {
              ...state,
              systemPromptSections: [...state.systemPromptSections, `Platform root at ${nextContext.workDir}.`],
              capabilityIds: [...state.capabilityIds, "platform-overlay"],
              policies: {
                ...state.policies,
                platformOverlayOwner: "platform-overlay",
              },
            }
          },
        },
      ],
    } satisfies {
      id: string
      extensions: PlatformRuntimeExtension[]
    }

    const assembly = assemblePlatformProfile(profile, context)

    expect(assembly.profileId).toBe("platform-profile")
    expect(assembly.systemPrompt).toBe("Platform root at /tmp/platform-profile.")
    expect(assembly.capabilityIds).toEqual(["platform-overlay"])
    expect(assembly.policies.platformOverlayOwner).toBe("platform-overlay")
  })

  it("reuses the platform-first composer contract across multiple non-AI overlays", () => {
    const context: PlatformRuntimeAssemblyContext = {
      workDir: "/tmp/platform-overlays",
    }
    const createOverlayProfile = (profileId: string, overlayId: string) => ({
      id: profileId,
      extensions: [
        {
          id: overlayId,
          apply(state: PlatformRuntimeAssemblyState, nextContext: PlatformRuntimeAssemblyContext) {
            return {
              ...state,
              systemPromptSections: [...state.systemPromptSections, `${overlayId} at ${nextContext.workDir}.`],
              capabilityIds: [...state.capabilityIds, overlayId],
              policies: {
                ...state.policies,
                [`${overlayId}Owner`]: overlayId,
              },
            }
          },
        },
      ],
    }) satisfies {
      id: string
      extensions: PlatformRuntimeExtension[]
    }

    const opsAssembly = assemblePlatformProfile(createOverlayProfile("ops-platform", "ops-overlay"), context)
    const dataAssembly = assemblePlatformProfile(createOverlayProfile("data-platform", "data-overlay"), context)

    expect(opsAssembly.profileId).toBe("ops-platform")
    expect(opsAssembly.systemPrompt).toBe("ops-overlay at /tmp/platform-overlays.")
    expect(opsAssembly.capabilityIds).toEqual(["ops-overlay"])
    expect(opsAssembly.policies["ops-overlayOwner"]).toBe("ops-overlay")

    expect(dataAssembly.profileId).toBe("data-platform")
    expect(dataAssembly.systemPrompt).toBe("data-overlay at /tmp/platform-overlays.")
    expect(dataAssembly.capabilityIds).toEqual(["data-overlay"])
    expect(dataAssembly.policies["data-overlayOwner"]).toBe("data-overlay")
  })

  it("seeds built-in ai-coding delegate agents and runtime assembly when no agents are configured", () => {
    const assembly = assembleAiCodingRuntimeProfile({
      workDir: "/tmp/codex-workdir",
      skillsDescription: "- skill-a: does something useful",
      loadedAgents: {},
      delegateAgentDescriptions: "- reviewer: reviews code",
    })

    expect(assembly.profileId).toBe("ai-coding")
    expect(Object.keys(assembly.agentConfigs)).toEqual(["code", "explorer", "librarian", "oracle", "designer", "fixer"])
    expect(assembly.agentConfigs.code?.description).toBe("默认编码执行 agent，用于通用的委派 coding 工作。")
    expect(assembly.agentConfigs.explorer?.prompt.join("\n")).toContain("只读，不做代码修改")
    expect(assembly.agentConfigs.librarian?.prompt.join("\n")).toContain("不依赖固定 MCP 名称")
    expect(assembly.agentConfigs.fixer?.prompt.join("\n")).toContain("诊断类工具/MCP")
    expect(assembly.systemPrompt).toContain("你是位于 /tmp/codex-workdir 的 coding agent。")
    expect(assembly.systemPrompt).toContain("可以通过 RunDelegateActor 工具使用内置和用户配置的 delegate agent")
    expect(assembly.systemPrompt).toContain("- explorer: 只读代码库发现")
    expect(assembly.systemPrompt).toContain("`assign`、`assign:r`、`assign:n`、`assign:s`")
    expect(assembly.systemPrompt).toContain("MCP 工具调用没有默认的单次超时")
    expect(assembly.systemPrompt).toContain('`_eidolon: { "timeoutMs": <milliseconds> }`')
    expect(assembly.systemPrompt).toContain("300000ms")
    expect(assembly.systemPrompt).toContain("- reviewer: reviews code")
    expect(assembly.systemPrompt).toContain("诊断类工具/MCP")
    expect(assembly.slashCommandSurfaces).toEqual(["/goal", "/actor", "/member", "/holon"])
    expect(assembly.slashCommands.find((command) => command.namespace === "member")?.actions.list?.toolName).toBe("MemberList")
    expect(assembly.capabilityIds).toEqual(["mod-platform-kernel", "mod-ai-kernel", "mod-ai-coding"])
    expect(assembly.policies.runtimeBootstrapOwner).toBe("mod-ai-kernel")
    expect(assembly.policies.delegateAgentSelectionOwner).toBe("mod-ai-coding")
    expect(assembly.policies.defaultAppProfile).toBe("coding")
    expect(assembly.allTools.some((tool) => tool.function.name === "Skill")).toBe(true)
    expect(assembly.allTools.some((tool) => tool.function.name === "RunDelegateActor")).toBe(true)
    const defaultDelegateTool = assembly.allTools.find((tool) => tool.function.name === "RunDelegateActor")
    const defaultAgentTypeSchema = JSON.stringify(defaultDelegateTool?.function.parameters.properties.agent_type ?? {})
    expect(defaultAgentTypeSchema).toContain("\"code\"")
    expect(defaultAgentTypeSchema).toContain("\"explorer\"")
    expect(defaultAgentTypeSchema).toContain("\"librarian\"")
    expect(defaultAgentTypeSchema).toContain("\"oracle\"")
    expect(defaultAgentTypeSchema).toContain("\"designer\"")
    expect(defaultAgentTypeSchema).toContain("\"fixer\"")

    const registries = assembly.createRegistries()
    expect(AgentRegistry.keys(registries.agentRegistry)).toEqual(["code", "explorer", "librarian", "oracle", "designer", "fixer"])
    expect(ToolFuncRegistry.get(registries.toolRegistry, "ActorAssign")).toBeTruthy()

    const toolset = assembly.buildToolset({
      mcpManager: null,
      outerCtx: { workDir: "/tmp/codex-workdir" },
      registries,
    } as any)
    expect(toolset.some((tool) => tool.function.name === "Skill")).toBe(true)
  })

  it("appends workspace AGENTS.md instructions to the ai-coding system prompt", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-profile-agents-md-"))
    fs.writeFileSync(path.join(workDir, "AGENTS.md"), "workspace-only instructions\n", "utf-8")

    try {
      const assembly = assembleAiCodingRuntimeProfile({
        workDir,
        skillsDescription: "",
        loadedAgents: {},
        delegateAgentDescriptions: "",
      })

      expect(assembly.systemPrompt).toContain(`你是位于 ${workDir} 的 coding agent。`)
      expect(assembly.systemPrompt).toEndWith("AGENTS.md (workspace):\nworkspace-only instructions")
      expect(assembly.systemPrompt).not.toContain("AGENTS.md (home)")
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })

  it("merges explicitly loaded agents with built-in ai-coding delegates", () => {
    const loadedAgents = {
      reviewer: {
        name: "reviewer",
        description: "Reviews code",
        tools: ["Read"],
        prompt: ["Review carefully."],
      },
    }

    const assembly = assembleAiCodingRuntimeProfile({
      workDir: "/tmp/codex-workdir",
      skillsDescription: "- skill-a: does something useful",
      loadedAgents,
      delegateAgentDescriptions: "- reviewer: reviews code",
    })

    expect(assembly.agentConfigs.reviewer).toEqual(loadedAgents.reviewer)
    expect(assembly.agentConfigs.explorer?.description).toContain("只读代码库发现")
    expect(AgentRegistry.keys(assembly.createRegistries().agentRegistry)).toEqual([
      "code",
      "explorer",
      "librarian",
      "oracle",
      "designer",
      "fixer",
      "reviewer",
    ])

    const delegateTool = assembly.allTools.find((tool) => tool.function.name === "RunDelegateActor")
    const agentTypeSchema = JSON.stringify(delegateTool?.function.parameters.properties.agent_type ?? {})

    expect(agentTypeSchema).toContain("reviewer")
    expect(agentTypeSchema).toContain("\"code\"")
    expect(agentTypeSchema).toContain("\"explorer\"")
  })

  it("loads workspace agents from AGENT.md folder definitions", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-profile-agent-md-"))
    const agentDir = path.join(workDir, ".eidolon", "agents", "reviewer")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, "AGENT.md"),
      [
        "---",
        "name: reviewer",
        "type: subagent",
        "description: 代码审查 agent。",
        "identity_asset: IDENTITY.md",
        "routing_asset: ROUTING.md",
        "tools:",
        "  - read",
        "  - grep",
        "---",
        "你是 Reviewer，负责审查风险。",
      ].join("\n"),
      "utf-8",
    )
    fs.writeFileSync(path.join(agentDir, "IDENTITY.md"), "保持只读，输出问题优先。", "utf-8")
    fs.writeFileSync(path.join(agentDir, "ROUTING.md"), "适合代码审查和风险排序。", "utf-8")

    try {
      const agents = loadAgentsFromDir(path.join(workDir, ".eidolon", "agents"))

      expect(agents.reviewer?.description).toBe("代码审查 agent。")
      expect(agents.reviewer?.tools).toEqual(["read", "grep"])
      expect(agents.reviewer?.prompt.join("\n")).toContain("保持只读")
      expect(agents.reviewer?.prompt.join("\n")).toContain("风险排序")
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })

  it("wires the support-backed skill loader into the ai-coding runtime registries", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-profile-skills-"))
    const skillDir = path.join(workDir, ".eidolon", "skills", "demo")
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: demo",
        "description: Demo skill",
        "---",
        "Skill body",
      ].join("\n"),
    )

    try {
      const assembly = assembleAiCodingRuntimeProfile({
        workDir,
        skillsDescription: "",
        loadedAgents: {},
        delegateAgentDescriptions: "",
      })

      const registries = assembly.createRegistries()
      SkillRegistry.reloadFromDir(registries.skillRegistry, path.join(workDir, ".eidolon", "skills"))

      expect(SkillRegistry.keys(registries.skillRegistry)).toEqual(["demo"])
      expect(SkillRegistry.getSkillContent(registries.skillRegistry, "demo")).toContain("Skill body")
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })

  it("keeps platform-support baseline helpers domain-agnostic", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-support-baseline-"))
    const projectRoot = path.join(workDir, "workspace")
    const nestedLeaf = path.join(projectRoot, "apps", "demo")
    fs.mkdirSync(path.join(projectRoot, ".eidolon"), { recursive: true })
    fs.mkdirSync(nestedLeaf, { recursive: true })

    try {
      expect(findNearestProjectRoot(nestedLeaf)).toBe(projectRoot)
      expect(resolveProjectWorkDir(nestedLeaf)).toBe(projectRoot)
      expect(resolveProjectWorkDir(nestedLeaf, "../shared")).toBe(path.resolve(nestedLeaf, "../shared"))

      const registriesA = createPlatformRuntimeRegistries()
      const registriesB = createPlatformRuntimeRegistries()

      expect(ToolFuncRegistry.list(registriesA.toolRegistry)).toEqual([])
      expect(AgentRegistry.keys(registriesA.agentRegistry)).toEqual([])
      expect(SkillRegistry.keys(registriesA.skillRegistry)).toEqual([])
      expect(registriesA.toolRegistry).not.toBe(registriesB.toolRegistry)
      expect(registriesA.agentRegistry).not.toBe(registriesB.agentRegistry)
      expect(registriesA.skillRegistry).not.toBe(registriesB.skillRegistry)
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })

  it("supports a minimal second-domain spike on top of the platform baseline without AI context", () => {
    type OpsSpikeState = PlatformRuntimeAssemblyState & {
      bootstrap: null | {
        createRegistries: () => ReturnType<typeof createPlatformRuntimeRegistries>
      }
      opsCapabilities: string[]
    }

    const context: PlatformRuntimeAssemblyContext = {
      workDir: "/tmp/ops-spike",
    }
    const initialState: OpsSpikeState = {
      systemPromptSections: [],
      capabilityIds: [],
      policies: {},
      bootstrap: null,
      opsCapabilities: [],
    }

    const withPlatformBaseline = applyModPlatformKernel(initialState, context)
    const withOpsOverlay: OpsSpikeState = {
      ...withPlatformBaseline,
      systemPromptSections: [...withPlatformBaseline.systemPromptSections, `Ops domain at ${context.workDir}.`],
      capabilityIds: [...withPlatformBaseline.capabilityIds, "ops-domain-spike"],
      policies: {
        ...withPlatformBaseline.policies,
        domainOwner: "ops-domain-spike",
      },
      opsCapabilities: ["ops-review"],
    }

    const registries = withOpsOverlay.bootstrap?.createRegistries()

    expect(withOpsOverlay.systemPromptSections).toEqual([`Ops domain at ${context.workDir}.`])
    expect(withOpsOverlay.capabilityIds).toEqual(["mod-platform-kernel", "ops-domain-spike"])
    expect(withOpsOverlay.policies.runtimeBootstrapOwner).toBe("mod-platform-kernel")
    expect(withOpsOverlay.policies.platformSupportOwner).toBe("@cell/platform-support")
    expect(withOpsOverlay.policies.domainOwner).toBe("ops-domain-spike")
    expect(withOpsOverlay.opsCapabilities).toEqual(["ops-review"])
    expect(registries ? ToolFuncRegistry.list(registries.toolRegistry) : undefined).toEqual([])
    expect(registries ? AgentRegistry.keys(registries.agentRegistry) : undefined).toEqual([])
    expect(registries ? SkillRegistry.keys(registries.skillRegistry) : undefined).toEqual([])
  })

  it("applies kernel before coding in the formal runtime profiles", () => {
    expect(platformOnlyRuntimeProfile.id).toBe("platform-only")
    expect(platformOnlyRuntimeProfile.extensions.map((extension) => extension.id)).toEqual([
      "mod-platform-kernel",
    ])
    expect(aiKernelRuntimeProfile.extensions.map((extension) => extension.id)).toEqual([
      "mod-platform-kernel",
      "mod-ai-kernel",
    ])
    expect(aiCodingRuntimeProfile.extensions.map((extension) => extension.id)).toEqual([
      "mod-platform-kernel",
      "mod-ai-kernel",
      "mod-ai-coding",
    ])
  })

  it("keeps platform-only free of implicit AI runtime capabilities while exposing a real platform baseline", () => {
    const assembly = assemblePlatformOnlyRuntimeProfile({
      workDir: "/tmp/platform-only-profile",
      skillsDescription: "",
      loadedAgents: {},
      delegateAgentDescriptions: "",
    })
    const registries = assembly.createRegistries()

    expect(assembly.profileId).toBe("platform-only")
    expect(assembly.capabilityIds).toEqual(["mod-platform-kernel"])
    expect(assembly.policies.runtimeBootstrapOwner).toBe("mod-platform-kernel")
    expect(assembly.policies.platformSupportOwner).toBe("@cell/platform-support")
    expect(assembly.runtimeCatalog).toBeNull()
    expect(assembly.runtimeSupport).toBeNull()
    expect(assembly.slashCommands).toEqual([])
    expect(assembly.slashCommandSurfaces).toEqual([])
    expect(assembly.allTools).toEqual([])
    expect(assembly.systemPrompt).toBe("")
    expect(ToolFuncRegistry.list(registries.toolRegistry)).toEqual([])
    expect(AgentRegistry.keys(registries.agentRegistry)).toEqual([])
    expect(SkillRegistry.keys(registries.skillRegistry)).toEqual([])
  })

  it("keeps ai-kernel explicit without silently adding coding overlay defaults", () => {
    const assembly = assembleAiKernelRuntimeProfile({
      workDir: "/tmp/ai-kernel-profile",
      skillsDescription: "- kernel-skill",
      loadedAgents: {},
      delegateAgentDescriptions: "",
    })

    expect(assembly.profileId).toBe("ai-kernel")
    expect(assembly.capabilityIds).toEqual(["mod-platform-kernel", "mod-ai-kernel"])
    expect(assembly.policies.runtimeBootstrapOwner).toBe("mod-ai-kernel")
    expect(assembly.policies.platformSupportOwner).toBe("@cell/platform-support")
    expect(assembly.policies.defaultAppProfile).toBeUndefined()
    expect(assembly.runtimeCatalog).toBeTruthy()
    expect(assembly.runtimeSupport).toBeTruthy()
    expect(typeof assembly.runtimeSupport?.createAgentLoader).toBe("function")
    expect(typeof assembly.runtimeSupport?.resolveActorModelConfig).toBe("function")
    expect(Object.keys(assembly.agentConfigs)).toEqual([])
    expect(ToolFuncRegistry.get(assembly.createRegistries().toolRegistry, "ActorAssign")).toBeTruthy()
  })

  it("lets custom extensions participate in assembly through composer-owned contract types", () => {
    const customExtension: RuntimeExtension = {
      id: "custom-overlay",
      apply(state, context) {
        return {
          ...state,
          systemPromptSections: [...state.systemPromptSections, `Custom overlay at ${context.workDir}.`],
          capabilityIds: [...state.capabilityIds, "custom-overlay"],
          policies: {
            ...state.policies,
            customOverlayOwner: "custom-overlay",
          },
        }
      },
    }

    const assembly = assembleRuntimeProfile(
      {
        id: "custom-profile",
        extensions: [customExtension],
      },
      {
        workDir: "/tmp/custom-profile",
        skillsDescription: "",
        loadedAgents: {},
        delegateAgentDescriptions: "",
      },
    )

    expect(assembly.profileId).toBe("custom-profile")
    expect(assembly.systemPrompt).toContain("Custom overlay at /tmp/custom-profile.")
    expect(assembly.capabilityIds).toEqual(["custom-overlay"])
    expect(assembly.policies.customOverlayOwner).toBe("custom-overlay")
  })
})
