import type { ToolSchema } from "@cell/ai-core-contract/types"
import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig"
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import { SkillRegistry } from "@cell/ai-core-logic/runtime/SkillRegistry"
import path from "path"
import { buildBuiltinToolDefs, INTERNAL_ONLY_BUILTIN_TOOL_NAMES } from "./ToolFuncBuiltin"

const DYNAMIC_TOOL_NAMES = new Set(["RunDelegateActor", "Skill"])
const INTERNAL_ONLY_TOOL_NAMES = INTERNAL_ONLY_BUILTIN_TOOL_NAMES
const BUILTIN_TOOL_DEFS = buildBuiltinToolDefs()

function cloneSchema(schema: ToolSchema): ToolSchema {
  return structuredClone(schema)
}

function getBuiltinSchemaByName(name: string): ToolSchema {
  const found = BUILTIN_TOOL_DEFS.find((def) => def.schema.function.name === name)
  if (!found) {
    throw new Error(`Built-in tool schema not found: ${name}`)
  }
  return cloneSchema(found.schema)
}

export const BASE_TOOLS: ToolSchema[] = BUILTIN_TOOL_DEFS
  .map((def) => def.schema)
  .filter((schema) => !DYNAMIC_TOOL_NAMES.has(schema.function.name))
  .filter((schema) => !INTERNAL_ONLY_TOOL_NAMES.has(schema.function.name))
  .map((schema) => cloneSchema(schema))

export function getAgentDescriptions(agents: Readonly<Record<string, AgentConfig>>): string {
  return Object.entries(agents)
    .map(([name, cfg]) => `- ${name}: ${cfg.description}`)
    .join("\n")
}

export function buildTaskTool(agents: Readonly<Record<string, AgentConfig>>): ToolSchema {
  const schema = getBuiltinSchemaByName("RunDelegateActor")
  schema.function.description = `Spawn a delegate actor for a focused subtask.\n\nAgent types:\n${getAgentDescriptions(agents)}`
  schema.function.parameters.properties.agent_type = {
    type: "string",
    enum: Object.keys(agents),
  }
  return schema
}

export function buildSkillTool(skillsDescription: string): ToolSchema {
  const schema = getBuiltinSchemaByName("Skill")
  schema.function.description =
    `Load a skill to gain specialized knowledge for a task.\n\nAvailable skills:\n${skillsDescription}\n\nWhen to use:\n- IMMEDIATELY when user task matches a skill description\n- Before attempting domain-specific work (PDF, MCP, etc.)\n\nThe skill content will be injected into the conversation, giving you detailed instructions and access to resources.`
  return schema
}

export function buildAllTools(skillsDescription: string, agents: Readonly<Record<string, AgentConfig>>): ToolSchema[] {
  return [...BASE_TOOLS, buildTaskTool(agents), buildSkillTool(skillsDescription)]
}

export function getToolsForAgent(agents: Readonly<Record<string, AgentConfig>>, agentType: string): ToolSchema[] {
  const allowed = agents[agentType]?.tools ?? "*"
  if (allowed === "*") return [...BASE_TOOLS]
  return BASE_TOOLS.filter((t) => allowed.includes(t.function.name) && !INTERNAL_ONLY_TOOL_NAMES.has(t.function.name))
}

export function buildToolset(
  allTools: ToolSchema[],
  vm: Pick<AiAgentVm, "mcpManager" | "outerCtx" | "registries">,
): ToolSchema[] {
  const tools = allTools.filter((t) => String(t?.function?.name ?? "") !== "Skill")

  const workDir = vm.outerCtx.workDir
  const skillsDescription = (() => {
    if (typeof workDir !== "string" || !workDir.trim()) {
      return "(workDir not configured; skill list unavailable)"
    }
    const skillsDir = path.join(workDir, ".eidolon", "skills")
    SkillRegistry.reloadFromDir(vm.registries.skillRegistry, skillsDir)
    return SkillRegistry.getDescriptions(vm.registries.skillRegistry)
  })()

  tools.push(buildSkillTool(skillsDescription))

  const mcpManager = vm.mcpManager
  if (mcpManager) {
    tools.push(...mcpManager.getOpenaiTools())
  }
  return tools
}
