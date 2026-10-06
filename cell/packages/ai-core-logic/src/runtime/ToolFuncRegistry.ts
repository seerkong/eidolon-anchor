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
      const policy = tool.resourceEffect ?? "unclassified";
      const resources = vm.effects?.toolResources;
      if (!resources || policy === "orchestration" || policy === "read_only") {
        return await tool.run(extendedRuntime, args as any, {} as any);
      }
      const workDir = vm.outerCtx.workDir;
      if (typeof workDir !== "string" || !workDir) throw new Error("tool_resource_workdir_required");
      const lease = await resources.acquire({ workDir, kind: policy, signal: meta?.signal });
      try {
        meta?.signal?.throwIfAborted();
        return await tool.run(extendedRuntime, args as any, {} as any);
      } finally { lease.release(); }
    }

    const mcpManager: McpManagerLike | undefined = runtime.vm.mcpManager;

    if (mcpManager) {
      const knownTools: McpToolSchemaLike[] = mcpManager.getOpenaiTools();
      const matched = knownTools.find((t) => t.function.name === name);

      if (matched) {
        const coreLogic = async (_runtime: any, input: unknown, _config: Record<string, unknown>) => {
          const resources = vm.effects?.toolResources;
          if (!resources) return await mcpManager.callTool(name, input, { signal: meta?.signal });
          const workDir = vm.outerCtx.workDir;
          if (typeof workDir !== "string" || !workDir) throw new Error("tool_resource_workdir_required");
          const lease = await resources.acquire({ workDir, kind: "unclassified", signal: meta?.signal });
          let completionKnown = true;
          try {
            meta?.signal?.throwIfAborted();
            if (mcpManager.callToolOutcome) {
              const result = await mcpManager.callToolOutcome(name, input, { signal: meta?.signal });
              completionKnown = result.completion === "settled";
              return result.output;
            }
            return await mcpManager.callTool(name, input, { signal: meta?.signal });
          } catch (error) {
            completionKnown = false;
            throw error;
          } finally {
            if (completionKnown) lease.release();
            else lease.invalidate?.();
          }
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
