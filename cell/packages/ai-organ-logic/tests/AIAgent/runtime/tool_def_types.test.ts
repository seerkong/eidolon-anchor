import { describe, expect, it } from "bun:test";

import {
  runByFuncStyleAdapter,
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor";
import type { AiAgentOneActorRuntime, ToolDef, ToolSchema } from "@cell/ai-core-contract/types";

type EchoInput = { message: string };
type EchoConfig = { uppercase: boolean };
type EchoOutput = { text: string };

function buildEchoToolDef(): ToolDef<EchoInput, EchoOutput, EchoConfig> {
  const schema: ToolSchema = {
    type: "function",
    function: {
      name: "echo",
      description: "Echo input message.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    },
  };

  const coreLogic = async (_runtime: AiAgentOneActorRuntime, input: EchoInput, config: EchoConfig): Promise<EchoOutput> => {
    return {
      text: config.uppercase ? input.message.toUpperCase() : input.message,
    };
  };

  return {
    schema,
    briefPromptXnl: "<tool name=\"echo\" />",
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        stdMakeNullOuterComputed,
        stdMakeIdentityInnerRuntime,
        stdMakeIdentityInnerInput,
        stdMakeIdentityInnerConfig,
        coreLogic,
        stdMakeIdentityOuterOutput,
      );
    },
  };
}

describe("tool_def_types", () => {
  it("executes tool through standard run pipeline", async () => {
    const tool = buildEchoToolDef();
    const runtime = {
      vm: {} as AiAgentOneActorRuntime["vm"],
      actor: {} as AiAgentOneActorRuntime["actor"],
    };

    const output = await tool.run(runtime, { message: "hello" }, { uppercase: true });
    expect(output).toEqual({ text: "HELLO" });
  });
});
