import { OpenAICompletionsNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm";
import { OpenAICompletionsNodejsFetchStreamAdapter } from "@cell/symbiont-logic/stream/OpenAICompletionsNodejsFetchStreamAdapter";
import { IngressStreams } from "@cell/symbiont-logic/stream/IngressStreams";

const API_KEY = process.env.MINIMAX_API_KEY || process.env.OPENAI_API_KEY || "";
const BASE_URL =
  process.env.MINIMAX_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  process.env.MINIMAX_OPENAI_BASE_URL ||
  "https://api.minimaxi.com/v1";
const MODEL = process.env.MINIMAX_MODEL || "MiniMax-M2.1";

if (!API_KEY) {
  console.error("Missing MINIMAX_API_KEY or OPENAI_API_KEY.");
  process.exit(1);
}

const tools = [
  {
    type: "function" as const,
    function: {
      name: "get_weather",
      description: "Get weather of a location, the user should supply a location first.",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "The city and state, e.g. San Francisco, US",
          },
        },
        required: ["location"],
      },
    },
  },
];


async function runOnce(messages: any[]) {
  const llm = new OpenAICompletionsNodejsFetchLlmAdapter({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
  });
  const request = {
    model: MODEL,
    messages,
    tools,
    extraBody: { reasoning_split: true },
  };
  console.log("[ts-openai] request", request);

  const { stream } = await llm.createStream(request);
  const ingress = new IngressStreams();
  const adapter = new OpenAICompletionsNodejsFetchStreamAdapter({
    ingressControl: ingress.control,
    ingressThink: ingress.think,
    ingressContent: ingress.content,
    ingressTool: ingress.tool,
  });
  const msg = await adapter.processStream(stream);
  await ingress.control.close();
  await ingress.think.close();
  await ingress.content.close();
  await ingress.tool.close();

  const summary = {
    content: msg.content,
    tool_calls: (msg.tool_calls || []).map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: tc.function?.arguments,
    })),
    reasoning_details: msg.reasoning_details,
  };
  console.log("[ts-openai] response", summary);

  return msg;
}

async function main() {
  const messages: any[] = [{ role: "user", content: "How's the weather in San Francisco?" }];

  const first = await runOnce(messages);
  if (!first.tool_calls || first.tool_calls.length === 0) {
    return;
  }

  const toolCall = first.tool_calls[0];
  const toolArgs = JSON.parse(toolCall.function?.arguments || "{}");
  console.log(`[ts-openai] tool_call ${toolCall.function?.name}(${toolArgs.location || ""})`);

  messages.push(first);
  messages.push({ role: "tool", tool_call_id: toolCall.id, content: "24℃, sunny" });

  await runOnce(messages);
}

main().catch((err) => {
  console.error("Error:", err?.message || err);
  process.exit(1);
});
