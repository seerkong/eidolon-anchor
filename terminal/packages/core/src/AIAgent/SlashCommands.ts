export {
  createAiSlashRuntime as createSlashRuntime,
  expandAiSlashPrompt as expandSlashPrompt,
  getAiSlashNamespaceHelp as getSlashNamespaceHelp,
  resolveAiSlashCommand as resolveSlashCommand,
} from "@cell/mod-ai-kernel";

export type {
  RuntimeDirectSlashCommand as DirectSlashCommand,
  RuntimePromptSlashCommand as PromptSlashCommand,
  RuntimeResolvedSlashCommand as ResolvedSlashCommand,
  RuntimeSlashCommandActionDescriptor as SlashCommandActionDescriptor,
  RuntimeSlashCommandActionParse as SlashCommandActionParse,
  RuntimeSlashCommandDescriptor as SlashCommandDescriptor,
  RuntimeSlashCommandNamespace as DirectSlashNamespace,
} from "@cell/ai-core-contract";
