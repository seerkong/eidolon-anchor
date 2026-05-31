import path from "path";

import {
  type FileAccessKind,
  type LocalPermissionAction,
  type LocalPermissionRule,
  type LocalPermissionsConfig,
  type WorkspaceAccessConfig,
  loadLocalPermissionsConfig,
  loadWorkspaceAccessConfig,
  protectedPermissionConfigPaths,
  workspaceAccessGrantRoot,
  LocalPermissionConfigError,
} from "./LocalPermissionConfig";

const SEGMENT_OPERATORS = new Set(["&&", "||", ";", "|", "&"]);
const REDIRECTION_OPERATORS = new Set([">", ">>", "<", "<>", "&>", "&>>"]);
const FD_DUPLICATION_OPERATORS = new Set([">&", "<&"]);
const READ_ONLY_PROTECTED_PERMISSION_COMMANDS = new Set([
  "cat",
  "cmp",
  "diff",
  "grep",
  "head",
  "jq",
  "less",
  "ls",
  "more",
  "readlink",
  "realpath",
  "rg",
  "stat",
  "tail",
  "wc",
]);
const READ_ONLY_WORKSPACE_SAFE_BASH_COMMANDS = new Set([
  "basename",
  "cat",
  "cmp",
  "cut",
  "diff",
  "dirname",
  "echo",
  "grep",
  "head",
  "jq",
  "ls",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "sort",
  "stat",
  "tail",
  "uniq",
  "wc",
  "which",
]);
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const HEREDOC_START_RE = /<<-?\s*(?<quote>['"]?)(?<delimiter>[A-Za-z_][A-Za-z0-9_]*)\k<quote>/;
const FD_TARGET_RE = /^(?:\d+|-)$/;

export type BashToken = {
  text: string;
  kind: "word" | "operator";
  quoted?: boolean;
};

export type LocalPermissionApprovalGrant = {
  kind: "local_permission";
  toolName: string;
  permissionName: "bash" | "read" | "edit";
  workDir: string;
  target: string;
};

export type WorkspaceAccessApprovalGrant = {
  kind: "workspace_access_grant";
  toolName: string;
  workDir: string;
  grantPath: string;
  requestedAccessKind: FileAccessKind;
};

export type LocalPermissionDecision = {
  action: LocalPermissionAction;
  message?: string;
  fallbackMessage?: string;
  matchedRule?: LocalPermissionRule;
  permissionName?: "bash" | "read" | "edit";
  target?: string;
  resolvedPath?: string;
  approvalGrant?: LocalPermissionApprovalGrant | WorkspaceAccessApprovalGrant;
};

export function resolveRequestedPath(workDir: string, rawPath: string): string {
  const home = process.env.HOME;
  const expanded =
    rawPath === "~"
      ? home || rawPath
      : rawPath.startsWith("~/") && home
        ? path.join(home, rawPath.slice(2))
        : rawPath;
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.resolve(workDir, expanded));
}

export function pathPatternInput(workDir: string, resolvedPath: string): string {
  return isPathWithin(resolvedPath, workDir) ? path.relative(workDir, resolvedPath) || "." : resolvedPath;
}

export function parseBashCommandSegments(command: string): string[] {
  return parseBashSegments(command).map((segmentTokens) => normalizeBashSegment(segmentTokens));
}

export function evaluateLocalToolPermission(params: {
  workDir: string;
  toolName: string;
  payload: Record<string, unknown>;
  authorityRoot?: string;
  approvalGrant?: LocalPermissionApprovalGrant | WorkspaceAccessApprovalGrant;
  additionalWritableRoots?: string[];
}): LocalPermissionDecision {
  const workDir = path.resolve(params.workDir);
  const {
    toolName,
    payload,
    authorityRoot,
    approvalGrant,
    additionalWritableRoots = [],
  } = params;

  if (toolName === "bash") {
    const command = String(payload.command ?? "");
    let segmentTokensList: BashToken[][];
    try {
      segmentTokensList = parseBashSegments(command);
    } catch (error) {
      const fallback = evaluateUnsupportedBashSyntax({
        error,
        command,
        workDir,
        authorityRoot,
        approvalGrant,
      });
      if (fallback) return fallback;
      throw error;
    }
    const normalizedSegments = segmentTokensList.map((segmentTokens) => {
      if (bashSegmentModifiesProtectedPermissionConfig(segmentTokens, workDir, authorityRoot)) {
        throw new Error("Protected local permission config path cannot be modified via generic bash commands");
      }
      return normalizeBashSegment(segmentTokens);
    });
    const serializedTarget = serializeBashSegments(normalizedSegments);
    let firstAskRule: LocalPermissionRule | undefined;
    let firstAskSegment: string | undefined;
    for (const segment of normalizedSegments) {
      const decision = evaluatePermissionRuleSet({
        workDir,
        permissionName: "bash",
        pattern: segment,
        authorityRoot,
      });
      if (decision.action === "deny" && !decision.matchedRule && bashSegmentIsWorkspaceSafe(segment)) {
        continue;
      }
      if (decision.action === "deny") {
        return {
          action: "deny",
          message: `local permission denied for bash segment: ${segment}`,
          matchedRule: decision.matchedRule,
          permissionName: "bash",
          target: serializedTarget,
        };
      }
      if (decision.action === "ask" && !firstAskSegment) {
        firstAskRule = decision.matchedRule;
        firstAskSegment = segment;
      }
    }
    if (firstAskSegment) {
      if (matchesApprovalGrant(approvalGrant, "bash", workDir, serializedTarget)) {
        return { action: "allow", permissionName: "bash", target: serializedTarget };
      }
      return {
        action: "ask",
        message: `Approve bash segment '${firstAskSegment}'?`,
        fallbackMessage: `local permission requires approval for bash segment: ${firstAskSegment}`,
        matchedRule: firstAskRule,
        permissionName: "bash",
        target: serializedTarget,
        approvalGrant: {
          kind: "local_permission",
          toolName: "bash",
          permissionName: "bash",
          workDir,
          target: serializedTarget,
        },
      };
    }
    return { action: "allow", permissionName: "bash", target: serializedTarget };
  }

  if (toolName === "read") {
    return evaluateFilePermission({
      workDir,
      rawPath: String(payload.filePath ?? ""),
      accessKind: "read",
      toolName,
      authorityRoot,
      approvalGrant,
      additionalWritableRoots,
    });
  }

  if (toolName === "ls" || toolName === "glob" || toolName === "grep") {
    return evaluateFilePermission({
      workDir,
      rawPath: typeof payload.path === "string" && payload.path.trim() ? String(payload.path) : ".",
      accessKind: "read",
      toolName,
      authorityRoot,
      approvalGrant,
      additionalWritableRoots,
    });
  }

  if (toolName === "write" || toolName === "edit" || toolName === "multiedit" || toolName === "apply_patch") {
    return evaluateFilePermission({
      workDir,
      rawPath: String(payload.filePath ?? ""),
      accessKind: "write",
      toolName,
      authorityRoot,
      approvalGrant,
      additionalWritableRoots,
    });
  }

  return { action: "allow" };
}

export function evaluateFilePermission(params: {
  workDir: string;
  rawPath: string;
  accessKind: FileAccessKind;
  toolName: string;
  authorityRoot?: string;
  approvalGrant?: LocalPermissionApprovalGrant | WorkspaceAccessApprovalGrant;
  additionalWritableRoots?: string[];
}): LocalPermissionDecision {
  const {
    workDir,
    rawPath,
    accessKind,
    toolName,
    authorityRoot,
    approvalGrant,
    additionalWritableRoots = [],
  } = params;
  const resolvedWorkDir = path.resolve(workDir);
  const resolvedPath = resolveRequestedPath(resolvedWorkDir, rawPath);
  const resolvedAdditionalRoots = additionalWritableRoots.map((candidate) => path.resolve(candidate));

  if (accessKind === "write" && isProtectedPermissionConfigPath(resolvedPath, authorityRoot)) {
    return {
      action: "deny",
      message: "Protected local permission config path cannot be modified via generic file tools",
      permissionName: "edit",
      target: pathPatternInput(resolvedWorkDir, resolvedPath),
      resolvedPath,
    };
  }

  if (resolvedAdditionalRoots.some((root) => isPathWithin(resolvedPath, root))) {
    return {
      action: "allow",
      permissionName: accessKind === "read" ? "read" : "edit",
      target: pathPatternInput(resolvedWorkDir, resolvedPath),
      resolvedPath,
    };
  }

  if (!isPathWithin(resolvedPath, resolvedWorkDir)) {
    const workspaceDecision = evaluateWorkspaceAccessGate({
      workDir: resolvedWorkDir,
      resolvedPath,
      accessKind,
      authorityRoot,
      toolName,
      approvalGrant,
    });
    return {
      ...workspaceDecision,
      resolvedPath,
      permissionName: accessKind === "read" ? "read" : "edit",
      target: pathPatternInput(resolvedWorkDir, resolvedPath),
    };
  }

  const permissionName = accessKind === "read" ? "read" : "edit";
  const pattern = pathPatternInput(resolvedWorkDir, resolvedPath);
  const decision = evaluatePermissionRuleSet({
    workDir: resolvedWorkDir,
    permissionName,
    pattern,
    authorityRoot,
  });

  if (decision.action === "deny" && !decision.matchedRule) {
    return {
      action: "allow",
      permissionName,
      target: pattern,
      resolvedPath,
    };
  }

  if (decision.action === "deny") {
    return {
      action: "deny",
      message: `local permission denied for ${permissionName} path: ${pattern}`,
      matchedRule: decision.matchedRule,
      permissionName,
      target: pattern,
      resolvedPath,
    };
  }
  if (decision.action === "ask") {
    if (matchesApprovalGrant(approvalGrant, permissionName, resolvedWorkDir, pattern)) {
      return {
        action: "allow",
        permissionName,
        target: pattern,
        resolvedPath,
      };
    }
    return {
      action: "ask",
      message: `Approve ${permissionName} path '${pattern}'?`,
      fallbackMessage: `local permission requires approval for ${permissionName} path: ${pattern}`,
      matchedRule: decision.matchedRule,
      permissionName,
      target: pattern,
      resolvedPath,
      approvalGrant: {
        kind: "local_permission",
        toolName,
        permissionName,
        workDir: resolvedWorkDir,
        target: pattern,
      },
    };
  }
  return {
    action: "allow",
    permissionName,
    target: pattern,
    resolvedPath,
  };
}

export function evaluatePermissionRuleSet(params: {
  workDir: string;
  permissionName: "bash" | "read" | "edit";
  pattern: string;
  authorityRoot?: string;
}): { action: LocalPermissionAction; matchedRule?: LocalPermissionRule } {
  const rules = selectEffectivePermissionRules(params.workDir, params.authorityRoot);
  let matchedRule: LocalPermissionRule | undefined;
  for (const rule of rules) {
    if (!globMatch(rule.permission, params.permissionName)) continue;
    if (!globMatch(rule.pattern, params.pattern)) continue;
    matchedRule = rule;
  }
  if (!matchedRule) {
    return { action: "deny" };
  }
  return { action: matchedRule.action, matchedRule };
}

export function selectEffectivePermissionRules(workDir: string, authorityRoot?: string): LocalPermissionRule[] {
  const config: LocalPermissionsConfig = loadLocalPermissionsConfig(authorityRoot);
  const resolvedWorkDir = path.resolve(workDir);
  const orderedRules = [...config.rules];
  const matchingOverrides = [...config.overrides]
    .filter((override) => isPathWithin(resolvedWorkDir, override.directory))
    .sort((a, b) => a.directory.split(path.sep).length - b.directory.split(path.sep).length || a.directory.localeCompare(b.directory));
  for (const override of matchingOverrides) {
    orderedRules.push(...override.rules);
  }
  return orderedRules;
}

export function isPathWithin(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function serializeBashSegments(segments: string[]): string {
  return JSON.stringify(segments);
}

export function isProtectedPermissionConfigPath(resolvedPath: string, authorityRoot?: string): boolean {
  return protectedPermissionConfigPaths(authorityRoot).some((protectedPath) => path.resolve(protectedPath) === path.resolve(resolvedPath));
}

function evaluateWorkspaceAccessGate(params: {
  workDir: string;
  resolvedPath: string;
  accessKind: FileAccessKind;
  authorityRoot?: string;
  toolName: string;
  approvalGrant?: LocalPermissionApprovalGrant | WorkspaceAccessApprovalGrant;
}): LocalPermissionDecision {
  const config: WorkspaceAccessConfig = loadWorkspaceAccessConfig(params.authorityRoot);
  const entries = config.workspaces[path.resolve(params.workDir)] ?? [];
  const matchingEntries = entries.filter((entry) => isPathWithin(params.resolvedPath, entry.path));
  if (matchingEntries.length === 0) {
    const grantPath = workspaceAccessGrantRoot(params.resolvedPath);
    const fallbackMessage =
      params.accessKind === "write"
        ? `Path is outside workspace access map: ${params.resolvedPath}`
        : `Path is outside workspace access map: ${params.resolvedPath}`;
    if (
      params.approvalGrant &&
      params.approvalGrant.kind === "workspace_access_grant" &&
      path.resolve(params.approvalGrant.workDir) === path.resolve(params.workDir) &&
      path.resolve(params.approvalGrant.grantPath) === path.resolve(grantPath) &&
      (
        params.approvalGrant.requestedAccessKind === "write" ||
        params.approvalGrant.requestedAccessKind === params.accessKind
      )
    ) {
      return { action: "allow" };
    }
    return {
      action: "ask",
      message:
        params.accessKind === "write"
          ? `Allow this workspace to grant read-write access to '${grantPath}'?`
          : `Allow this workspace to grant access to '${grantPath}'?`,
      fallbackMessage,
      approvalGrant: {
        kind: "workspace_access_grant",
        toolName: params.toolName,
        workDir: path.resolve(params.workDir),
        grantPath,
        requestedAccessKind: params.accessKind,
      },
    };
  }
  const chosen = matchingEntries.sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path))[0];
  if (!chosen.permissions.has(params.accessKind)) {
    return {
      action: "deny",
      message:
        params.accessKind === "write"
          ? `Path is not writable for workspace: ${params.resolvedPath}`
          : `Path is not readable for workspace: ${params.resolvedPath}`,
    };
  }
  return { action: "allow" };
}

function evaluateUnsupportedBashSyntax(params: {
  error: unknown;
  command: string;
  workDir: string;
  authorityRoot?: string;
  approvalGrant?: LocalPermissionApprovalGrant | WorkspaceAccessApprovalGrant;
}): LocalPermissionDecision | null {
  if (
    !(params.error instanceof LocalPermissionConfigError) ||
    params.error.message !== "Unsupported shell syntax for permission parsing"
  ) {
    return null;
  }
  if (bashRawCommandReferencesProtectedPermissionConfig(params.command, params.workDir, params.authorityRoot)) {
    throw new Error("Protected local permission config path cannot be modified via generic bash commands");
  }

  const rawCommand = params.command.trim();
  const serializedTarget = serializeBashSegments([rawCommand]);
  const decision = evaluatePermissionRuleSet({
    workDir: params.workDir,
    permissionName: "bash",
    pattern: rawCommand,
    authorityRoot: params.authorityRoot,
  });
  if (decision.action === "allow" && decision.matchedRule) {
    return { action: "allow", permissionName: "bash", target: serializedTarget };
  }
  if (decision.action === "deny" && decision.matchedRule) {
    return {
      action: "deny",
      message: "local permission denied for bash command with unsupported syntax",
      matchedRule: decision.matchedRule,
      permissionName: "bash",
      target: serializedTarget,
    };
  }
  if (matchesApprovalGrant(params.approvalGrant, "bash", params.workDir, serializedTarget)) {
    return { action: "allow", permissionName: "bash", target: serializedTarget };
  }
  return {
    action: "ask",
    message: "Approve bash command with unsupported syntax?",
    fallbackMessage: "local permission requires approval for unsupported bash syntax",
    matchedRule: decision.matchedRule,
    permissionName: "bash",
    target: serializedTarget,
    approvalGrant: {
      kind: "local_permission",
      toolName: "bash",
      permissionName: "bash",
      workDir: params.workDir,
      target: serializedTarget,
    },
  };
}

function parseBashSegments(command: string): BashToken[][] {
  const stripped = sanitizeSupportedBashMultilineCommand(command);
  if (!stripped) {
    throw new LocalPermissionConfigError("Bash command is empty");
  }
  if (stripped.includes("\n") || stripped.includes("\r")) {
    throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
  }
  const tokens = tokenizeBashInput(stripped);
  const segments: BashToken[][] = [];
  let current: BashToken[] = [];
  for (const token of tokens) {
    if (token.kind === "operator" && SEGMENT_OPERATORS.has(token.text)) {
      if (current.length === 0) {
        throw new LocalPermissionConfigError(`Invalid shell syntax near operator '${token.text}'`);
      }
      segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) {
    segments.push(current);
  }
  if (segments.length === 0) {
    throw new LocalPermissionConfigError("No executable bash segments found");
  }
  return segments;
}

function collapseBashMultilineCommand(command: string): string {
  const lines = command.split(/\r\n|\n|\r/);
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (result.length > 0 && result[result.length - 1].trimEnd().endsWith("\\")) {
      // Backslash line continuation: strip trailing \ and join
      const prev = result[result.length - 1].trimEnd();
      result[result.length - 1] = prev.slice(0, -1) + " " + line.trimStart();
    } else if (result.length > 0 && lineHasUnclosedQuote(result[result.length - 1])) {
      // Quoted string spans multiple lines: join and preserve the newline in the token
      result[result.length - 1] += " " + line;
    } else {
      result.push(line);
    }
  }
  return result.join("\n");
}

function lineHasUnclosedQuote(line: string): boolean {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "'" && !double) { single = !single; }
    if (ch === '"' && !single) { double = !double; }
  }
  return single || double;
}

function sanitizeSupportedBashMultilineCommand(command: string): string {
  const stripped = command.trim();
  if (!stripped.includes("\n") && !stripped.includes("\r")) {
    return stripped;
  }

  // Collapse backslash-continued lines and quoted multiline strings
  const collapsed = collapseBashMultilineCommand(stripped);
  if (!collapsed.includes("\n") && !collapsed.includes("\r")) {
    return collapsed;
  }

  const lines = collapsed.split(/\r\n|\n|\r/);
  const sanitizedLines: string[] = [];
  let index = 0;
  let sawSupportedHeredoc = false;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
    }

    const match = HEREDOC_START_RE.exec(line);
    if (!match || match.index === undefined) {
      throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
    }

    const delimiter = String(match.groups?.delimiter ?? "").trim();
    if (!delimiter) {
      throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
    }

    const prefix = `${line.slice(0, match.index)} ${line.slice(match.index + match[0].length)}`.trim();
    if (!prefix) {
      throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
    }

    const prefixTokens = tokenizeBashInput(prefix);
    if (!bashSegmentAllowsSupportedHeredoc(prefixTokens)) {
      throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
    }

    sanitizedLines.push(prefix);
    sawSupportedHeredoc = true;
    index += 1;

    while (index < lines.length && lines[index].trim() !== delimiter) {
      index += 1;
    }
    if (index >= lines.length) {
      throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
    }
    index += 1;
  }

  if (!sawSupportedHeredoc) {
    throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
  }
  const sanitized = sanitizedLines.join(" ").trim();
  if (!sanitized) {
    throw new LocalPermissionConfigError("No executable bash segments found");
  }
  return sanitized;
}

function tokenizeBashInput(command: string): BashToken[] {
  const tokens: BashToken[] = [];
  let current = "";
  let currentQuoted = false;
  let quoteMode: "single" | "double" | null = null;
  let index = 0;

  const flushCurrent = () => {
    if (!current) return;
    tokens.push({
      text: current,
      kind: "word",
      quoted: currentQuoted,
    });
    current = "";
    currentQuoted = false;
  };

  const startsWith = (value: string) => command.startsWith(value, index);

  while (index < command.length) {
    const char = command[index];
    if (quoteMode === "single") {
      if (char === "'") {
        quoteMode = null;
      } else {
        current += char;
      }
      index += 1;
      continue;
    }
    if (quoteMode === "double") {
      if (char === '"') {
        quoteMode = null;
        index += 1;
        continue;
      }
      if (char === "\\") {
        if (index + 1 >= command.length) {
          throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
        }
        current += command[index + 1];
        currentQuoted = true;
        index += 2;
        continue;
      }
      if (startsWith("$(") || char === "`") {
        throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
      }
      current += char;
      index += 1;
      continue;
    }

    if (/\s/.test(char)) {
      flushCurrent();
      index += 1;
      continue;
    }
    if (char === "'") {
      quoteMode = "single";
      currentQuoted = true;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoteMode = "double";
      currentQuoted = true;
      index += 1;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= command.length) {
        throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
      }
      current += command[index + 1];
      currentQuoted = true;
      index += 2;
      continue;
    }
    if (startsWith("$(") || char === "`") {
      throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
    }
    if (startsWith("<(") || startsWith(">(") || startsWith("<<") || startsWith("|&")) {
      throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
    }
    if ("()".includes(char)) {
      throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
    }

    const operator = readShellOperator(command, index);
    if (operator) {
      flushCurrent();
      tokens.push({ text: operator, kind: "operator" });
      index += operator.length;
      continue;
    }

    current += char;
    index += 1;
  }

  if (quoteMode) {
    throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
  }
  flushCurrent();
  return tokens;
}

function readShellOperator(command: string, index: number): string | null {
  for (const operator of ["&>>", "&&", "||", ">>", "<>", "&>", ">&", "<&", ";", "|", "&", "<", ">"]) {
    if (command.startsWith(operator, index)) {
      return operator;
    }
  }
  return null;
}

function normalizeBashSegment(tokens: BashToken[]): string {
  return collectBashCommandWords(tokens).join(" ");
}

function bashSegmentAllowsSupportedHeredoc(tokens: BashToken[]): boolean {
  let commandTokens: string[];
  try {
    commandTokens = collectBashCommandWords(tokens);
  } catch {
    return false;
  }
  if (commandTokens.length < 2) return false;
  const executable = path.basename(commandTokens[0]).toLowerCase();
  if (!executable.startsWith("python")) return false;
  return commandTokens[commandTokens.length - 1] === "-";
}

function collectBashCommandWords(tokens: BashToken[]): string[] {
  if (tokens.length === 0) {
    throw new LocalPermissionConfigError("Empty bash segment");
  }
  let index = 0;
  while (index < tokens.length && tokens[index].kind === "word" && ENV_ASSIGNMENT_RE.test(tokens[index].text)) {
    index += 1;
  }
  const commandTokens: string[] = [];
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind === "operator" && ["<<", "|&"].includes(token.text)) {
      throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
    }
    if (isFdDuplicationRedirection(tokens, index)) {
      index += tokens[index].kind === "word" ? 3 : 2;
      continue;
    }
    if (
      token.kind === "word" &&
      !token.quoted &&
      /^\d+$/.test(token.text) &&
      index + 1 < tokens.length &&
      tokens[index + 1].kind === "operator" &&
      REDIRECTION_OPERATORS.has(tokens[index + 1].text)
    ) {
      if (index + 2 >= tokens.length || tokens[index + 2].kind !== "word") {
        throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
      }
      index += 3;
      continue;
    }
    if (token.kind === "operator" && REDIRECTION_OPERATORS.has(token.text)) {
      if (index + 1 >= tokens.length || tokens[index + 1].kind !== "word") {
        throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
      }
      index += 2;
      continue;
    }
    if (token.kind !== "word") {
      throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
    }
    if (!token.quoted && (token.text === "{" || token.text === "}")) {
      throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
    }
    commandTokens.push(token.text);
    index += 1;
  }
  if (commandTokens.length === 0) {
    throw new LocalPermissionConfigError("Bash segment does not contain an executable command");
  }
  return commandTokens;
}

function isFdDuplicationRedirection(tokens: BashToken[], index: number): boolean {
  const token = tokens[index];
  if (!token) return false;
  if (
    token.kind === "word" &&
    !token.quoted &&
    /^\d+$/.test(token.text) &&
    index + 2 < tokens.length &&
    tokens[index + 1].kind === "operator" &&
    FD_DUPLICATION_OPERATORS.has(tokens[index + 1].text) &&
    tokens[index + 2].kind === "word" &&
    !tokens[index + 2].quoted &&
    FD_TARGET_RE.test(tokens[index + 2].text)
  ) {
    return true;
  }
  return token.kind === "operator" &&
    FD_DUPLICATION_OPERATORS.has(token.text) &&
    index + 1 < tokens.length &&
    tokens[index + 1].kind === "word" &&
    !tokens[index + 1].quoted &&
    FD_TARGET_RE.test(tokens[index + 1].text);
}

function bashSegmentModifiesProtectedPermissionConfig(
  tokens: BashToken[],
  workDir: string,
  authorityRoot?: string,
): boolean {
  if (bashRedirectionTargetsProtectedPermissionConfig(tokens, workDir, authorityRoot)) {
    return true;
  }
  const commandTokens = collectBashCommandWords(tokens);
  if (commandTokens.length < 2) return false;
  const targetedArgs = commandTokens
    .slice(1)
    .filter((token) => bashTokenTargetsProtectedPermissionConfig(token, workDir, authorityRoot));
  if (targetedArgs.length === 0) return false;
  return !bashCommandIsReadOnly(commandTokens[0], commandTokens.slice(1));
}

function bashRedirectionTargetsProtectedPermissionConfig(
  tokens: BashToken[],
  workDir: string,
  authorityRoot?: string,
): boolean {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (
      token.kind === "word" &&
      !token.quoted &&
      /^\d+$/.test(token.text) &&
      index + 1 < tokens.length &&
      tokens[index + 1].kind === "operator" &&
      REDIRECTION_OPERATORS.has(tokens[index + 1].text)
    ) {
      if (index + 2 >= tokens.length || tokens[index + 2].kind !== "word") {
        throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
      }
      if (bashTokenTargetsProtectedPermissionConfig(tokens[index + 2].text, workDir, authorityRoot)) {
        return true;
      }
      index += 3;
      continue;
    }
    if (token.kind === "operator" && REDIRECTION_OPERATORS.has(token.text)) {
      if (index + 1 >= tokens.length || tokens[index + 1].kind !== "word") {
        throw new LocalPermissionConfigError("Unsupported shell syntax for permission parsing");
      }
      if (bashTokenTargetsProtectedPermissionConfig(tokens[index + 1].text, workDir, authorityRoot)) {
        return true;
      }
      index += 2;
      continue;
    }
    index += 1;
  }
  return false;
}

function bashCommandIsReadOnly(command: string, args: string[]): boolean {
  const executable = path.basename(command);
  if (READ_ONLY_PROTECTED_PERMISSION_COMMANDS.has(executable)) {
    return true;
  }
  if (executable === "sed") {
    return args.every((arg) => !String(arg).startsWith("-i"));
  }
  return false;
}

function bashSegmentIsWorkspaceSafe(segment: string): boolean {
  let tokens: BashToken[];
  let commandTokens: string[];
  try {
    tokens = tokenizeBashInput(segment);
    commandTokens = collectBashCommandWords(tokens);
  } catch {
    return false;
  }
  if (commandTokens.length === 0) return false;
  const executable = path.basename(commandTokens[0]);
  return READ_ONLY_WORKSPACE_SAFE_BASH_COMMANDS.has(executable);
}

function bashTokenTargetsProtectedPermissionConfig(text: string, workDir: string, authorityRoot?: string): boolean {
  const candidate = text.trim();
  if (!candidate) return false;
  return isProtectedPermissionConfigPath(resolveRequestedPath(workDir, candidate), authorityRoot);
}

function bashRawCommandReferencesProtectedPermissionConfig(command: string, workDir: string, authorityRoot?: string): boolean {
  const normalizedCommand = command.replace(/['"]/g, "");
  return protectedPermissionConfigPaths(authorityRoot).some((protectedPath) => {
    const resolvedPath = path.resolve(protectedPath);
    const candidates = [
      resolvedPath,
      path.relative(path.resolve(workDir), resolvedPath),
    ].filter((candidate) => candidate && candidate !== ".");
    return candidates.some((candidate) => normalizedCommand.includes(candidate));
  });
}

function matchesApprovalGrant(
  approvalGrant: LocalPermissionApprovalGrant | WorkspaceAccessApprovalGrant | undefined,
  permissionName: "bash" | "read" | "edit",
  workDir: string,
  target: string,
): boolean {
  return !!approvalGrant &&
    approvalGrant.kind === "local_permission" &&
    approvalGrant.permissionName === permissionName &&
    path.resolve(approvalGrant.workDir) === path.resolve(workDir) &&
    approvalGrant.target === target;
}

function globMatch(pattern: string, value: string): boolean {
  return new RegExp(`^${globPatternToRegex(pattern)}$`).test(value);
}

function globPatternToRegex(pattern: string): string {
  let out = "";
  for (const char of pattern) {
    if (char === "*") {
      out += ".*";
      continue;
    }
    if (char === "?") {
      out += ".";
      continue;
    }
    if ("\\^$+?.()|{}[]".includes(char)) {
      out += `\\${char}`;
      continue;
    }
    out += char;
  }
  return out;
}
