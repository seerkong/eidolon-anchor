import type {
  RuntimeAgentLoader,
  RuntimeAssemblyContext,
  RuntimeAssemblyState,
  RuntimeBootstrapDescriptor,
  RuntimeCatalogDescriptor,
  RuntimeModelConfigResolverParams,
  RuntimeSlashCommandDescriptor,
  RuntimeSlashCommandNamespace,
  RuntimeSupportDescriptor,
  RuntimeToolingDescriptor,
} from "@cell/ai-core-contract";
import { AgentRegistry, SkillRegistry } from "@cell/ai-core-logic";
import { buildAllTools, buildToolset as buildRuntimeToolset, composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent";
import {
  createLocalFileMessageHistoryEffects,
  createLocalFileOrchestrationHistoryEffects,
  loadAgentPresetConfig,
  loadLLMProviderConfig,
  loadSkillEntriesFromDir,
  LocalFileActorTranscriptStore,
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileAgentLoader,
  LocalFilePermissionConfigStore,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
  resolveActorModelConfigFromLocalFiles,
} from "@cell/ai-support";
import { createPlatformRuntimeRegistries } from "@cell/platform-support";
import { createAiSlashRuntime } from "./slash";

export const DEFAULT_KERNEL_SLASH_COMMAND_SURFACES = [
  "/actor",
  "/member",
  "/holon",
];

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values));
}

function mergeSlashCommandDescriptors(
  commands: RuntimeSlashCommandDescriptor[],
): RuntimeSlashCommandDescriptor[] {
  const merged = new Map<RuntimeSlashCommandNamespace, RuntimeSlashCommandDescriptor>();

  for (const command of commands) {
    const current = merged.get(command.namespace);
    if (!current) {
      merged.set(command.namespace, {
        namespace: command.namespace,
        actions: { ...command.actions },
      });
      continue;
    }

    merged.set(command.namespace, {
      namespace: command.namespace,
      actions: {
        ...current.actions,
        ...command.actions,
      },
    });
  }

  return Array.from(merged.values());
}

function createKernelToolingDescriptor(): RuntimeToolingDescriptor {
  return {
    buildAllTools: (state, context) => buildAllTools(context.skillsDescription, state.agentConfigs),
    buildToolset: (state, vm, context) =>
      buildRuntimeToolset(buildAllTools(context.skillsDescription, state.agentConfigs), vm),
  };
}

function createKernelBootstrapDescriptor(
  baseBootstrap: RuntimeBootstrapDescriptor | null,
): RuntimeBootstrapDescriptor {
  return {
    createRegistries: (state, context, options) => {
      const baseRegistries =
        baseBootstrap?.createRegistries(state, context, options) ??
        createPlatformRuntimeRegistries();
      const skillRegistry = baseRegistries.skillRegistry ?? new SkillRegistry();
      SkillRegistry.configureLoader(skillRegistry, loadSkillEntriesFromDir);
      return {
        toolRegistry: composeToolRegistry({ includeInternalOnly: options?.includeInternalOnly ?? false }),
        agentRegistry: new AgentRegistry(state.agentConfigs),
        skillRegistry,
      };
    },
  };
}

function createKernelRuntimeCatalogDescriptor(): RuntimeCatalogDescriptor {
  return {
    loadConfigBundle: (workDir) => ({
      providerConfig: loadLLMProviderConfig(workDir),
      presetConfig: loadAgentPresetConfig(workDir),
    }),
  };
}

function createKernelRuntimeSupportDescriptor(): RuntimeSupportDescriptor {
  return {
    createAgentLoader: (agentsDir): RuntimeAgentLoader => new LocalFileAgentLoader(agentsDir),
    resolveActorModelConfig: (params: RuntimeModelConfigResolverParams) =>
      resolveActorModelConfigFromLocalFiles(params),
    createMessageHistoryEffects: (params) => createLocalFileMessageHistoryEffects(params),
    createOrchestrationHistoryEffects: (params) => createLocalFileOrchestrationHistoryEffects(params),
    permissionConfigStore: LocalFilePermissionConfigStore,
    persistence: {
      actorTranscriptStore: LocalFileActorTranscriptStore,
      snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
      derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
      conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
    },
  };
}

function createKernelSlashCommandDescriptors(): RuntimeSlashCommandDescriptor[] {
  return [
    {
      namespace: "goal",
      actions: {
        status: {
          toolName: "GoalCommand",
          parse: { kind: "literal", form: "status" },
          help: "`/goal` or `/goal status` Show the current thread goal",
        },
        set: {
          toolName: "GoalCommand",
          parse: { kind: "rest", form: "set", argName: "objective" },
          help: "`/goal <objective>` or `/goal set <objective>` Set the active thread goal",
        },
        edit: {
          toolName: "GoalCommand",
          parse: { kind: "rest", form: "edit", argName: "objective" },
          help: "`/goal edit <objective>` Replace the current goal objective",
        },
        pause: {
          toolName: "GoalCommand",
          parse: { kind: "literal", form: "pause" },
          help: "`/goal pause` Pause the current goal",
        },
        resume: {
          toolName: "GoalCommand",
          parse: { kind: "literal", form: "resume" },
          help: "`/goal resume` Resume the current goal",
        },
        clear: {
          toolName: "GoalCommand",
          parse: { kind: "literal", form: "clear" },
          help: "`/goal clear` Clear the current goal",
        },
      },
    },
    {
      namespace: "actor",
      actions: {
        assign: {
          toolName: "ActorAssign",
          parse: { kind: "assign" },
          help: "`/actor assign <target> -- <content>` Final reply mode",
          promptForms: ["assign", "assign:r", "assign:n", "assign:s"],
        },
        status: {
          toolName: "ActorStatus",
          parse: { kind: "target", form: "status", argName: "target" },
          help: "`/actor status <target>` Show actor status",
        },
        watch: {
          toolName: "ActorWatch",
          parse: { kind: "target", form: "watch", argName: "target" },
          help: "`/actor watch <target>` Enable watched state",
        },
        unwatch: {
          toolName: "ActorUnwatch",
          parse: { kind: "target", form: "unwatch", argName: "target" },
          help: "`/actor unwatch <target>` Disable watched state",
        },
      },
    },
    {
      namespace: "member",
      actions: {
        list: {
          toolName: "MemberList",
          parse: { kind: "literal", form: "list" },
          help: "`/member list` List members",
        },
        status: {
          toolName: "MemberStatus",
          parse: { kind: "target", form: "status", argName: "target" },
          help: "`/member status <target>` Show member status",
        },
        create: {
          toolName: "MemberCreate",
          parse: { kind: "create_member", form: "create", defaultAgentType: "code" },
          help: "`/member create <name> [@agent_name] [-- <prompt>]` Create a member",
        },
        assign: {
          toolName: "MemberAssign",
          parse: { kind: "assign" },
          help: "`/member assign <target> -- <content>` Final reply mode",
          promptForms: ["assign", "assign:r", "assign:n", "assign:s"],
        },
      },
    },
    {
      namespace: "holon",
      actions: {
        status: {
          toolName: "HolonStatus",
          parse: { kind: "target", form: "status", argName: "target" },
          help: "`/holon status <target>` Show holon status",
        },
        create: {
          toolName: "HolonCreate",
          parse: { kind: "create_holon", form: "create" },
          help: "`/holon create <governance> <name>` Create a holon",
        },
        add: {
          toolName: "HolonAdd",
          parse: { kind: "pair", form: "add", argNames: ["holon", "member"] },
          help: "`/holon add <holon> <member>` Add a member to a holon",
        },
        appoint: {
          toolName: "HolonAppoint",
          parse: { kind: "pair", form: "appoint", argNames: ["holon", "member"] },
          help: "`/holon appoint <holon> <member>` Appoint a leader",
        },
        assign: {
          toolName: "HolonAssign",
          parse: { kind: "assign" },
          help: "`/holon assign <target> -- <content>` Final reply mode",
          promptForms: ["assign", "assign:r", "assign:n", "assign:s"],
        },
      },
    },
  ];
}

function formatDelegateAgentDescriptions(descriptions: string): string {
  const trimmed = descriptions.trim();
  return trimmed || "- workspace 配置中没有额外 delegate；coding profile 可能会添加内置 delegate，RunDelegateActor 的 agent_type schema 是最终可用列表。";
}

export function buildModAiKernelPromptSection(context: RuntimeAssemblyContext): string {
  return `工作循环：
  确定目标和成功条件 -> 行动 -> 观察 -> 评估剩余 gap -> 决策：已达成则完成；下一步明确且 gap 在收敛则继续；新证据推翻当前假设则重规划；无进展、受阻或超出预算则升级

**可用 Skill**（任务匹配 skill 描述时，用 Skill 工具加载）:
${context.skillsDescription}

**Workspace 配置的 delegate-task agents**（coding profile 可能会添加内置 delegate；聚焦子任务可调用 delegate task 工具）:
${formatDelegateAgentDescriptions(context.delegateAgentDescriptions)}

规则：
- 当任务匹配某个 skill 描述时，立即使用 Skill 工具加载。
- 对需要探索或实现的聚焦子任务，使用 RunDelegateActor 工具。
- 只有当工作确实包含多个依赖步骤、分支决策或有意义的可恢复状态时，才使用 TaskTreeWrite；小型直接修复不要使用。
- 需要完整 task-tree JSON 时，使用 TaskTreeRead。
- 优先使用正式 actor 模型：member / holon(governance=autonomous|leader_led)。
- 优先使用正式任务表面：\`assign\`、\`assign:r\`、\`assign:n\`、\`assign:s\`（\`assign\`/\`assign:r\` => \`final\`；\`assign:n\` => \`none\`；\`assign:s\` => \`stream\`）。
- 优先使用正式 watch 控制：watch / unwatch。
- 优先使用工具，不要只用文字解释；要行动。
- MCP 工具调用没有默认的单次超时。某次 MCP 调用需要有边界时，在工具参数里加入 \`_eidolon: { "timeoutMs": <milliseconds> }\`。使用合理的最小超时；runtime 会将上限限制为 300000ms，并在转发给 MCP server 前移除 \`_eidolon\`。
- 完成后总结变更。
- 将 /goal、/actor、/member、/holon 用户输入识别为正式快捷命令表面。
- 使用 get_goal 查看持久化 thread goal。只有用户明确要求跟踪 goal 时才使用 create_goal。只有基于证据确认 complete/blocked 状态时才使用 update_goal。`;
}

export function applyModAiKernel(
  state: RuntimeAssemblyState,
  context: RuntimeAssemblyContext,
): RuntimeAssemblyState {
  const slashCommands = mergeSlashCommandDescriptors([
    ...state.slashCommands,
    ...createKernelSlashCommandDescriptors(),
  ]);

  return {
    ...state,
    tooling: state.tooling ?? createKernelToolingDescriptor(),
    bootstrap: createKernelBootstrapDescriptor(state.bootstrap),
    runtimeCatalog: state.runtimeCatalog ?? createKernelRuntimeCatalogDescriptor(),
    runtimeSupport: state.runtimeSupport ?? createKernelRuntimeSupportDescriptor(),
    systemPromptSections: [...state.systemPromptSections, buildModAiKernelPromptSection(context)],
    slashCommands,
    slashRuntimeFactory: state.slashRuntimeFactory ?? createAiSlashRuntime,
    slashCommandSurfaces: uniqueValues([
      ...state.slashCommandSurfaces,
      ...slashCommands.map((command) => `/${command.namespace}`),
      ...DEFAULT_KERNEL_SLASH_COMMAND_SURFACES,
    ]),
    capabilityIds: uniqueValues([...state.capabilityIds, "mod-ai-kernel"]),
    policies: {
      ...state.policies,
      runtimeBootstrapOwner: "mod-ai-kernel",
      slashRouteOwner: "mod-ai-kernel",
      slashSurfaceOwner: "mod-ai-kernel",
      toolingOwner: "mod-ai-kernel",
    },
  };
}

export const applyModSysKernel = applyModAiKernel;
export const buildModSysKernelPromptSection = buildModAiKernelPromptSection;
export * from "./slash";
