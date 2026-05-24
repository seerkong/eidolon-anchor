/** Minimal mock OpenAI client that returns canned tool-calling response for MCP calculate */

export function createMockOpenAI() {
  return {
    chat: {
      completions: {
        create: async ({ messages }: any) => {
          const last = messages[messages.length - 1]?.content || "";
          const wantsCalc = String(last).toLowerCase().includes("use mcp calculate");
          const toolCall = wantsCalc
            ? [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "mcp__demo__calculate",
                    arguments: JSON.stringify({ a: 1, b: 3 }),
                  },
                },
              ]
            : [];
          let yielded = false;
          const iterator = {
            async *[Symbol.asyncIterator]() {
              if (toolCall.length) {
                yielded = true;
                yield {
                  choices: [
                    {
                      delta: {
                        tool_calls: toolCall.map((tc) => ({
                          id: tc.id,
                          index: 0,
                          type: tc.type,
                          function: { name: tc.function.name, arguments: tc.function.arguments },
                        })),
                      },
                    },
                  ],
                } as any;
              }
              yield { choices: [{ delta: { content: "Assistant reply" } }] } as any;
            },
          };
          return iterator as any;
        },
      },
    },
  };
}
