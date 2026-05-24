export type IngressSource = "content" | "think" | "tool" | "toolcall";

export type ToolCallType = "code" | "json";

export type AgentEventMeta = {
  agentKey: string;
  agentActorId: string;
};

export type ParsedXmlToolCall = {
  id: string;
  lang: string;
  code: string;
  funcId: string;
};

export type JsonToolCall = {
  id: string;
  type?: string;
  functionName: string;
  functionArguments: string;
};
