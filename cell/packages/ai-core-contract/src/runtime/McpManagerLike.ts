export type McpToolSchemaLike = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
};

export type McpManagerLike = {
  getOpenaiTools: () => McpToolSchemaLike[];
  callTool: (name: string, args: unknown) => Promise<string> | string;
};
