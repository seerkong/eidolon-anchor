import type {
  RuntimeDirectSlashCommand,
  RuntimePromptSlashCommand,
  RuntimeResolvedSlashCommand,
  RuntimeSlashCommandActionDescriptor,
  RuntimeSlashCommandActionParse,
  RuntimeSlashCommandDescriptor,
  RuntimeSlashCommandNamespace,
  RuntimeSlashRuntime,
} from "@cell/ai-core-contract";

function normalize(text: string): string {
  return text.trim();
}

function splitOnce(text: string, needle: string): [string, string] | null {
  const idx = text.indexOf(needle);
  if (idx < 0) return null;
  return [text.slice(0, idx), text.slice(idx + needle.length)];
}

function normalizeAgentType(token: string | undefined, fallback = "code"): string {
  const text = normalize(token ?? "").replace(/^@/, "");
  return text || fallback;
}

function parseAssignMode(action: string): "final" | "none" | "stream" | null {
  if (action === "assign" || action === "assign:r") return "final";
  if (action === "assign:n") return "none";
  if (action === "assign:s") return "stream";
  return null;
}

function resolveNamespaceDescriptor(
  namespace: RuntimeSlashCommandNamespace,
  commands: RuntimeSlashCommandDescriptor[],
): RuntimeSlashCommandDescriptor | null {
  return commands.find((command) => command.namespace === namespace) ?? null;
}

function parseAssignCommand(
  namespace: RuntimeSlashCommandNamespace,
  command: string,
  rest: string,
  action: string,
): RuntimeDirectSlashCommand | null {
  const trimmed = normalize(rest);
  const match = trimmed.match(/^(assign(?::[rns])?)\s+(.*)$/);
  if (!match) return null;
  const mode = parseAssignMode(match[1] ?? "");
  const payload = match[2] ?? "";
  if (!mode) return null;
  const pair = splitOnce(payload, "--");
  if (!pair) return null;
  const target = normalize(pair[0]);
  const content = normalize(pair[1]);
  if (!target || !content) return null;
  return {
    kind: "direct_execute",
    command,
    namespace,
    action,
    args: { target, mode, content },
  };
}

function parseCreateMemberCommand(
  namespace: RuntimeSlashCommandNamespace,
  command: string,
  action: string,
  rest: string,
  descriptor: Extract<RuntimeSlashCommandActionParse, { kind: "create_member" }>,
): RuntimeDirectSlashCommand | null {
  const trimmed = normalize(rest);
  const match = trimmed.match(new RegExp(`^${descriptor.form}(?:\\s+(.*))?$`));
  if (!match) return null;
  const raw = match[1] ?? "";
  const pair = splitOnce(raw, "--");
  const headText = normalize(pair ? pair[0] : raw);
  const prompt = normalize(pair ? pair[1] : "");
  const parts = headText.split(/\s+/).filter(Boolean);
  const [name = "", maybeAgent = ""] = parts;
  if (!name) return null;
  return {
    kind: "direct_execute",
    command,
    namespace,
    action,
    args: {
      name,
      agent_type: normalizeAgentType(maybeAgent, descriptor.defaultAgentType ?? "code"),
      prompt,
    },
  };
}

function parseCreateHolonCommand(
  namespace: RuntimeSlashCommandNamespace,
  command: string,
  action: string,
  rest: string,
  descriptor: Extract<RuntimeSlashCommandActionParse, { kind: "create_holon" }>,
): RuntimeDirectSlashCommand | null {
  const trimmed = normalize(rest);
  const match = trimmed.match(new RegExp(`^${descriptor.form}(?:\\s+(.*))?$`));
  if (!match) return null;
  const parts = normalize(match[1] ?? "").split(/\s+/).filter(Boolean);
  const [governance = "", name = ""] = parts;
  if (!name) return null;
  if (governance !== "autonomous" && governance !== "leader_led") return null;
  return {
    kind: "direct_execute",
    command,
    namespace,
    action,
    args: {
      governance,
      name,
    },
  };
}

function parseAction(
  namespace: RuntimeSlashCommandNamespace,
  command: string,
  rest: string,
  action: string,
  descriptor: RuntimeSlashCommandActionDescriptor,
): RuntimeDirectSlashCommand | null {
  const trimmed = normalize(rest);
  if (!trimmed) return null;

  switch (descriptor.parse.kind) {
    case "assign":
      return parseAssignCommand(namespace, command, trimmed, action);
    case "literal":
      return trimmed === descriptor.parse.form
        ? { kind: "direct_execute", command, namespace, action, args: {} }
        : null;
    case "target": {
      const prefix = `${descriptor.parse.form} `;
      if (!trimmed.startsWith(prefix)) return null;
      const value = normalize(trimmed.slice(prefix.length));
      if (!value) return null;
      return {
        kind: "direct_execute",
        command,
        namespace,
        action,
        args: { [descriptor.parse.argName ?? "target"]: value },
      };
    }
    case "name": {
      const prefix = `${descriptor.parse.form} `;
      if (!trimmed.startsWith(prefix)) return null;
      const value = normalize(trimmed.slice(prefix.length));
      if (!value) return null;
      return {
        kind: "direct_execute",
        command,
        namespace,
        action,
        args: { [descriptor.parse.argName ?? "name"]: value },
      };
    }
    case "pair": {
      const prefix = `${descriptor.parse.form} `;
      if (!trimmed.startsWith(prefix)) return null;
      const parts = normalize(trimmed.slice(prefix.length)).split(/\s+/).filter(Boolean);
      const [left = "", right = ""] = parts;
      if (!left || !right) return null;
      const [leftName, rightName] = descriptor.parse.argNames;
      return {
        kind: "direct_execute",
        command,
        namespace,
        action,
        args: { [leftName]: left, [rightName]: right },
      };
    }
    case "create_member":
      return parseCreateMemberCommand(namespace, command, action, trimmed, descriptor.parse);
    case "create_holon":
      return parseCreateHolonCommand(namespace, command, action, trimmed, descriptor.parse);
  }
}

function getPromptForms(descriptor: RuntimeSlashCommandActionDescriptor): string[] {
  if (descriptor.promptForms && descriptor.promptForms.length > 0) {
    return [...descriptor.promptForms];
  }

  switch (descriptor.parse.kind) {
    case "assign":
      return ["assign", "assign:r", "assign:n", "assign:s"];
    case "literal":
      return [descriptor.parse.form];
    case "target":
      return [descriptor.parse.form];
    case "name":
      return [descriptor.parse.form];
    case "pair":
      return [descriptor.parse.form];
    case "create_member":
      return [descriptor.parse.form];
    case "create_holon":
      return [descriptor.parse.form];
  }
}

function buildPromptExpand(
  namespace: RuntimeSlashCommandNamespace,
  descriptor: RuntimeSlashCommandDescriptor,
): RuntimePromptSlashCommand {
  const forms = Array.from(
    new Set(Object.values(descriptor.actions).flatMap((action) => getPromptForms(action))),
  );
  return {
    kind: "prompt_expand",
    command: `/${namespace}`,
    prompt: `Explain the supported /${namespace} forms: ${forms.join(", ")}.`,
  };
}

export function getAiSlashNamespaceHelp(
  namespace: RuntimeSlashCommandNamespace,
  commands: RuntimeSlashCommandDescriptor[],
): string {
  const descriptor = resolveNamespaceDescriptor(namespace, commands);
  const lines = [`\`/${namespace}\` commands:`, `- \`/${namespace} help\` Show this help message`];
  if (!descriptor) return lines.join("\n");
  for (const action of Object.values(descriptor.actions)) {
    lines.push(`- ${action.help}`);
  }
  return lines.join("\n");
}

export function resolveAiSlashCommand(
  input: string,
  commands: RuntimeSlashCommandDescriptor[],
): RuntimeResolvedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const namespaceMatch = trimmed.match(/^\/([a-z]+)(?:\s+(.*))?$/);
  if (!namespaceMatch) return null;

  const namespace = namespaceMatch[1] as RuntimeSlashCommandNamespace;
  const descriptor = resolveNamespaceDescriptor(namespace, commands);
  if (!descriptor) return null;

  const rest = normalize(namespaceMatch[2] ?? "");
  if (!rest || rest === "help") {
    return { kind: "direct_execute", command: `/${namespace}`, namespace, action: "help", args: {} };
  }

  for (const [action, actionDescriptor] of Object.entries(descriptor.actions)) {
    const resolved = parseAction(namespace, `/${namespace}`, rest, action, actionDescriptor);
    if (resolved) return resolved;
  }

  return buildPromptExpand(namespace, descriptor);
}

export function expandAiSlashPrompt(
  input: string,
  commands: RuntimeSlashCommandDescriptor[],
): RuntimePromptSlashCommand | null {
  const resolved = resolveAiSlashCommand(input, commands);
  if (!resolved || resolved.kind !== "prompt_expand") return null;
  return resolved;
}

export function createAiSlashRuntime(
  commands: RuntimeSlashCommandDescriptor[],
): RuntimeSlashRuntime {
  return {
    resolveCommand: (input) => resolveAiSlashCommand(input, commands),
    expandPrompt: (input) => expandAiSlashPrompt(input, commands),
    getNamespaceHelp: (namespace) => getAiSlashNamespaceHelp(namespace, commands),
  };
}
