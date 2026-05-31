import type { AnyToolDef, AiAgentOneActorRuntime } from "@cell/ai-core-contract/types";
import type { AiAgentActor } from "./actor";
import type { AiAgentVm } from "./runtime";
import type { McpManagerLike, McpToolSchemaLike } from "@cell/ai-core-contract/runtime/McpManagerLike";
import { ToolFuncRegistryData } from "@cell/ai-core-contract/runtime/RuntimeRegistries";
import {
  runByFuncStyleAdapter,
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor";

export { ToolFuncRegistryData } from "@cell/ai-core-contract/runtime/RuntimeRegistries";

export class ToolFuncRegistry extends ToolFuncRegistryData {
  register(tool: AnyToolDef): void {
    ToolFuncRegistry.register(this, tool);
  }

  registerMany(tools: AnyToolDef[]): void {
    ToolFuncRegistry.registerMany(this, tools);
  }

  get(name: string): AnyToolDef | undefined {
    return ToolFuncRegistry.get(this, name);
  }

  list(): AnyToolDef[] {
    return ToolFuncRegistry.list(this);
  }

  async call(
    name: string,
    vm: AiAgentVm,
    actor: AiAgentActor,
    args: unknown,
    meta?: { toolCallId?: string; localPermissionGrant?: unknown; signal?: AbortSignal },
  ): Promise<unknown> {
    return await ToolFuncRegistry.call(this, name, vm, actor, args, meta);
  }

  static create(entries: Record<string, AnyToolDef> = {}): ToolFuncRegistryData {
    return new ToolFuncRegistryData(entries);
  }

  static register(registry: ToolFuncRegistryData, tool: AnyToolDef): void {
    registry.registry[tool.schema.function.name] = tool;
  }

  static registerMany(registry: ToolFuncRegistryData, tools: AnyToolDef[]): void {
    for (const tool of tools) {
      ToolFuncRegistry.register(registry, tool);
    }
  }

  static get(registry: ToolFuncRegistryData, name: string): AnyToolDef | undefined {
    return registry.registry[name];
  }

  static list(registry: ToolFuncRegistryData): AnyToolDef[] {
    return Object.values(registry.registry);
  }

  static async call(
    registry: ToolFuncRegistryData,
    name: string,
    vm: AiAgentVm,
    actor: AiAgentActor,
    args: unknown,
    meta?: { toolCallId?: string; localPermissionGrant?: unknown; signal?: AbortSignal },
  ): Promise<unknown> {
    const runtime: AiAgentOneActorRuntime<AiAgentVm, AiAgentActor> = { vm, actor };
    const extendedRuntime = {
      ...runtime,
      toolCallId: meta?.toolCallId,
      localPermissionGrant: meta?.localPermissionGrant,
      signal: meta?.signal,
    } as any;

    const tool = ToolFuncRegistry.get(registry, name);
    if (tool) {
      return await tool.run(extendedRuntime, args as any, {} as any);
    }

    const mcpManager: McpManagerLike | undefined = runtime.vm.mcpManager;

    if (mcpManager) {
      const knownTools: McpToolSchemaLike[] = mcpManager.getOpenaiTools();
      const matched = knownTools.find((t) => t.function.name === name);

      if (matched) {
        const coreLogic = async (_runtime: any, input: unknown, _config: Record<string, unknown>) => {
          return await mcpManager.callTool(name, input);
        };

        return await runByFuncStyleAdapter(
          extendedRuntime,
          args as any,
          {} as any,
          stdMakeNullOuterComputed,
          stdMakeIdentityInnerRuntime,
          stdMakeIdentityInnerInput,
          stdMakeIdentityInnerConfig,
          coreLogic,
          stdMakeIdentityOuterOutput,
        );
      }
    }

    return `Unknown tool: ${name}`;
  }
}
