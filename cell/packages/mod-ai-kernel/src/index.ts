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
  return trimmed || "- none";
}

export function buildModAiKernelPromptSection(context: RuntimeAssemblyContext): string {
  return `work loop: 
  确定目标和成功条件 -> 行动 -> 观察 -> 评估剩余 gap -> 决策：已达成则完成；下一步明确且 gap 在收敛则继续；新证据推翻当前假设则重规划；无进展、受阻或超出预算则升级

**Skills available** (invoke with Skill tool when task matches):
${context.skillsDescription}

**Delegate-task agents available** (invoke the delegate task tool for focused subtasks):
${formatDelegateAgentDescriptions(context.delegateAgentDescriptions)}

Rules:
- Use Skill tool IMMEDIATELY when a task matches a skill description
- Use the RunDelegateActor tool for focused subtasks needing exploration or implementation
- Use TaskTreeWrite only when the work truly has multiple dependent steps, branching decisions, or meaningful resumable state; skip it for small direct fixes
- Use TaskTreeRead when you need full task-tree JSON
- Prefer the formal actor model: member / holon(governance=autonomous|leader_led)
- Prefer the formal task surface: \`assign\`, \`assign:r\`, \`assign:n\`, \`assign:s\` (\`assign\`/\`assign:r\` => \`final\`; \`assign:n\` => \`none\`; \`assign:s\` => \`stream\`)
- Prefer the formal watch controls: watch / unwatch
- Prefer tools over prose. Act, don't just explain.
- After finishing, summarize what changed.
- Recognize /actor, /member, and /holon user inputs as the formal shortcut command surface.`;
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
