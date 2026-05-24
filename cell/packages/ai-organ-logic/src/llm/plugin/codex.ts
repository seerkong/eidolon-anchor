import type { Plugin, ProviderConfigMap } from "../ProviderPlugins";
import codexInstructionsPrompt from "./prompt/GptInstructionsV5-1.md" with { type: "text" };

type SandboxPermissions = {
  sandboxMode: string;
  networkAccess: string;
  approvalPolicy: string;
};

function loadCodexInstructions(): string {
  return codexInstructionsPrompt;
}

function buildSandboxPrompt(): string {
  const envPermissions = {
    sandboxMode: process.env.SANDBOX_MODE,
    networkAccess: process.env.NETWORK_ACCESS,
    approvalPolicy: process.env.APPROVAL_POLICY,
  };
  const rawPermissions = (globalThis as any).__sandbox_permissions as
    | (Partial<SandboxPermissions> & {
        sandbox_mode?: string;
        network_access?: string;
        approval_policy?: string;
      })
    | undefined;
  const permissions: SandboxPermissions = {
    sandboxMode:
      rawPermissions?.sandboxMode || rawPermissions?.sandbox_mode || envPermissions.sandboxMode || "workspace-write",
    networkAccess:
      rawPermissions?.networkAccess || rawPermissions?.network_access || envPermissions.networkAccess || "enabled",
    approvalPolicy:
      rawPermissions?.approvalPolicy || rawPermissions?.approval_policy || envPermissions.approvalPolicy || "on-failure",
  };
  return `Sandbox permissions:\n- sandbox_mode: ${permissions.sandboxMode}\n- network_access: ${permissions.networkAccess}\n- approval_policy: ${permissions.approvalPolicy}`;
}

function buildInsertText(current: string, instructions: string, sandboxPrompt: string): string {
  const parts: string[] = [];
  if (instructions && !current.includes(instructions)) parts.push(instructions);
  if (!current.includes(sandboxPrompt)) parts.push(sandboxPrompt);
  if (!parts.length) return current;
  const prefix = parts.join("\n\n");
  if (!current.trim()) return prefix;
  return `${prefix}\n\n${current}`;
}

function injectSystemPrompts(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const instructions = loadCodexInstructions().trim();
  const sandboxPrompt = buildSandboxPrompt();
  const first = messages[0] ?? {};
  if (Array.isArray(first.content)) {
    const currentText = first.content
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n");
    const updated = buildInsertText(currentText, instructions, sandboxPrompt);
    if (updated !== currentText) {
      const blockType = first.content[0]?.type || "text";
      first.content = [{ type: blockType, text: updated }];
    }
  } else {
    const currentText = typeof first.content === "string" ? first.content : "";
    const updated = buildInsertText(currentText, instructions, sandboxPrompt);
    if (updated !== currentText) {
      first.content = updated;
    }
  }
  const rest = messages.slice(1);
  return [first, ...rest];
}

function injectDeveloperPrompts(input: any[]): any[] {
  if (!Array.isArray(input) || input.length === 0) return input;
  const instructions = loadCodexInstructions().trim();
  const sandboxPrompt = buildSandboxPrompt();
  const first = input[0] ?? {};
  if (Array.isArray(first.content)) {
    const currentText = first.content
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n");
    const updated = buildInsertText(currentText, instructions, sandboxPrompt);
    if (updated !== currentText) {
      const blockType = first.content[0]?.type || "input_text";
      first.content = [{ type: blockType, text: updated }];
    }
  } else {
    const currentText = typeof first.content === "string" ? first.content : "";
    const updated = buildInsertText(currentText, instructions, sandboxPrompt);
    if (updated !== currentText) {
      first.content = updated;
    }
  }
  const rest = input.slice(1);
  return [first, ...rest];
}

async function codexFetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
  if (!init?.body || typeof init.body !== "string") {
    return globalThis.fetch(input, init);
  }

  try {
    const originalBody = JSON.parse(init.body);

    if (Array.isArray(originalBody.messages)) {
      originalBody.messages = injectSystemPrompts(originalBody.messages);
    }
    if (Array.isArray(originalBody.input)) {
      originalBody.input = injectDeveloperPrompts(originalBody.input);
    }

    delete originalBody.max_output_tokens;
    delete originalBody.max_completion_tokens;

    const modifiedInit: RequestInit = {
      ...init,
      body: JSON.stringify(originalBody),
    };

    return globalThis.fetch(input, modifiedInit);
  } catch {
    return globalThis.fetch(input, init);
  }
}

/**
 * Codex Proxy Plugin
 *
 * Intercepts requests to OpenCode providers and applies custom fetch handling
 * to modify request parameters before they are sent to the API.
 */
export const CodexProxyPlugin: Plugin = async () => {
  return {
    config: async (input: unknown) => {
      const config = input as { provider?: ProviderConfigMap };
      ["openai-yunyi-cfd"].forEach((providerName) => {
        const provider = config.provider?.[providerName];
        if (provider) {
          if (!provider.options) {
            provider.options = {};
          }
          provider.options.fetch = codexFetch;
        }
      });
    },
  };
};

export default CodexProxyPlugin;
