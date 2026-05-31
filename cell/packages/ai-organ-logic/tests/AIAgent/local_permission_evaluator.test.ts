import { afterEach, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { configureLocalPermissionConfigStore } from "@cell/ai-organ-logic";
import {
  evaluateLocalToolPermission,
  parseBashCommandSegments,
} from "@cell/ai-organ-logic/permissions/LocalPermissionEvaluator";
import { LocalFilePermissionConfigStore } from "@cell/ai-support";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "organ-local-permission-"));
  tempRoots.push(root);
  return root;
}

function writePermissions(authorityRoot: string, permission: Record<string, unknown>): void {
  fs.mkdirSync(authorityRoot, { recursive: true });
  fs.writeFileSync(
    path.join(authorityRoot, "permissions.json"),
    JSON.stringify({ permission }, null, 2),
  );
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("local permission evaluator", () => {
  it("splits bash segments while preserving quoted separators", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    expect(parseBashCommandSegments(`printf ";" && git status`)).toEqual(["printf ;", "git status"]);
    expect(() => parseBashCommandSegments("echo hi $(whoami)")).toThrow("Unsupported shell syntax");
  });

  it("uses the bash segment parser for compound command permissions", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    writePermissions(authorityRoot, {
      "*": "deny",
      bash: {
        "git *": "allow",
        "grep *": "allow",
        "printf *": "allow",
        "rm *": "deny",
      },
    });

    const denied = evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: "git status && rm -rf tmp" },
      authorityRoot,
    });
    const allowed = evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: "printf 'foo\\nbar\\n' | grep foo" },
      authorityRoot,
    });
    const backgroundDenied = evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: "git status & rm -rf tmp" },
      authorityRoot,
    });

    expect(denied.action).toBe("deny");
    expect(denied.message).toContain("local permission denied for bash segment: rm -rf tmp");
    expect(allowed.action).toBe("allow");
    expect(backgroundDenied.action).toBe("deny");
    expect(backgroundDenied.message).toContain("local permission denied for bash segment: rm -rf tmp");
  });

  it("normalizes env prefixes, redirection, and fd duplication out of bash segments", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);

    expect(parseBashCommandSegments("FOO=1 BAR=2 git status > out.txt")).toEqual(["git status"]);
    expect(parseBashCommandSegments("cd /tmp 2>&1 && git status 2>&1")).toEqual(["cd /tmp", "git status"]);
  });

  it("keeps quoted control characters as bash arguments", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);

    expect(parseBashCommandSegments("printf ';'")).toEqual(["printf ;"]);
    expect(parseBashCommandSegments("printf '&&'")).toEqual(["printf &&"]);
    expect(parseBashCommandSegments("printf '|'")).toEqual(["printf |"]);
    expect(parseBashCommandSegments('printf ">"')).toEqual(["printf >"]);
  });

  it("allows brace expansion inside bash path words", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);

    expect(
      parseBashCommandSegments("mkdir -p src/teaching_agent/{common,lexical,syntactic} tests"),
    ).toEqual(["mkdir -p src/teaching_agent/{common,lexical,syntactic} tests"]);
  });

  it("fails closed on unsupported bash syntax", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);

    for (const command of [
      "git status $(cat x)",
      "(rm -rf tmp)",
      "{ rm -rf tmp; }",
      "git diff <(cat a)",
      "git diff >(cat)",
    ]) {
      expect(() => parseBashCommandSegments(command)).toThrow("Unsupported shell syntax for permission parsing");
    }
  });

  it("requires approval for unsupported multiline bash commands", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    writePermissions(authorityRoot, {
      "*": "deny",
      bash: { "git *": "allow" },
    });

    const decision = evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: "git status\nrm -rf tmp" },
      authorityRoot,
    });
    expect(decision.action).toBe("ask");
    expect(decision.fallbackMessage).toContain("unsupported bash syntax");
    expect(decision.target).toBe(JSON.stringify(["git status\nrm -rf tmp"]));
  });

  it("requires approval for unsupported bash syntax instead of throwing a parser error", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    writePermissions(authorityRoot, {
      "*": "ask",
      bash: {
        "git *": "allow",
      },
    });

    const command =
      "for f in $(find . -name 'step-config-def.json' | sort); do if grep -q \"task_template\" \"$f\" 2>/dev/null; then echo \"HAS: $f\"; fi; done";
    const decision = evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command },
      authorityRoot,
    });

    expect(decision.action).toBe("ask");
    expect(decision.message).toContain("unsupported syntax");
    expect(decision.approvalGrant).toMatchObject({
      kind: "local_permission",
      permissionName: "bash",
      target: JSON.stringify([command]),
    });

    expect(evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command },
      authorityRoot,
      approvalGrant: decision.approvalGrant,
    }).action).toBe("allow");
  });

  it("allows supported python heredoc commands when the normalized rule matches", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    writePermissions(authorityRoot, {
      "*": "deny",
      bash: { "python3 *": "allow" },
    });

    expect(parseBashCommandSegments("python3 - <<'PY'\nprint('hi')\nPY")).toEqual(["python3 -"]);
    expect(evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: "python3 - <<'PY'\nprint('hi')\nPY" },
      authorityRoot,
    }).action).toBe("allow");
  });

  it("requires approval for python heredoc forms that cannot be normalized safely", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    writePermissions(authorityRoot, {
      "*": "ask",
      bash: { "python3 *": "allow" },
    });

    const command = "python3 << 'PYEOF'\nprint('hi')\nPYEOF";
    const decision = evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command },
      authorityRoot,
    });

    expect(parseBashCommandSegments("python3 - <<'PYEOF'\nprint('hi')\nPYEOF")).toEqual(["python3 -"]);
    expect(() => parseBashCommandSegments(command)).toThrow("Unsupported shell syntax");
    expect(decision.action).toBe("ask");
    expect(decision.target).toBe(JSON.stringify([command]));
  });

  it("collapses backslash line continuations before permission parsing", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    writePermissions(authorityRoot, {
      "*": "deny",
      bash: { "git *": "allow" },
    });

    // Backslash continuation: git add \ then files on next lines
    expect(parseBashCommandSegments(
      "git add \\\n  file1.py \\\n  file2.py"
    )).toEqual(["git add file1.py file2.py"]);

    expect(evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: "git add \\\n  file1.py \\\n  file2.py" },
      authorityRoot,
    }).action).toBe("allow");
  });

  it("collapses quoted multiline strings before permission parsing", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    writePermissions(authorityRoot, {
      "*": "deny",
      bash: { "git *": "allow" },
    });

    // Quoted string spanning multiple lines: git commit -m "msg\n..."
    expect(parseBashCommandSegments(
      'git commit -m "line1\nline2\nline3"'
    )).toEqual(['git commit -m line1 line2 line3']);

    expect(evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: 'git commit -m "line1\nline2"' },
      authorityRoot,
    }).action).toBe("allow");
  });

  it("denies redirect writes to protected local permission files", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    writePermissions(authorityRoot, {
      "*": "deny",
      bash: { "printf *": "allow" },
    });

    expect(() => evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: `printf hi > ${path.join(authorityRoot, "permissions.json")}` },
      authorityRoot,
    })).toThrow("Protected local permission config path");
  });

  it("still blocks protected permission config writes when bash syntax is unsupported", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    writePermissions(authorityRoot, {
      "*": "ask",
    });

    expect(() => evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: `echo $(printf hi > ${path.join(authorityRoot, "permissions.json")})` },
      authorityRoot,
    })).toThrow("Protected local permission config path");
  });

  it("applies directory overrides with last-match-wins for internal read paths", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(path.join(workDir, "docs"), { recursive: true });
    fs.mkdirSync(path.join(workDir, "secure"), { recursive: true });
    fs.mkdirSync(authorityRoot, { recursive: true });
    fs.writeFileSync(
      path.join(authorityRoot, "permissions.json"),
      JSON.stringify(
        {
          permission: {
            "*": "deny",
            read: {
              "*": "deny",
            },
          },
          overrides: [
            {
              directory: workDir,
              permission: {
                read: {
                  "docs/*": "allow",
                },
              },
            },
            {
              directory: path.join(workDir, "secure"),
              permission: {
                read: "deny",
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    expect(
      evaluateLocalToolPermission({
        workDir,
        toolName: "read",
        payload: { filePath: "docs/guide.md" },
        authorityRoot,
      }).action,
    ).toBe("allow");

    const denied = evaluateLocalToolPermission({
      workDir: path.join(workDir, "secure"),
      toolName: "read",
      payload: { filePath: "note.txt" },
      authorityRoot,
    });
    expect(denied.action).toBe("deny");
    expect(denied.message).toContain("local permission denied");
  });

  it("allows in-workspace file reads by default when no permission rule matches", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(authorityRoot, { recursive: true });
    fs.writeFileSync(path.join(workDir, "note.txt"), "hello");

    const result = evaluateLocalToolPermission({
      workDir,
      toolName: "read",
      payload: { filePath: "note.txt" },
      authorityRoot,
    });

    expect(result.action).toBe("allow");
  });

  it("allows workspace-safe bash reads by default when no bash rule matches", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(authorityRoot, { recursive: true });

    const result = evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: "pwd && rg --files" },
      authorityRoot,
    });

    expect(result.action).toBe("allow");
  });

  it("still denies non-whitelisted bash commands by default when no bash rule matches", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(authorityRoot, { recursive: true });

    const result = evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: "python -c 'print(1)'" },
      authorityRoot,
    });

    expect(result.action).toBe("deny");
    expect(result.message).toContain("local permission denied for bash segment");
  });

  it("uses last matching bash pattern so broad allow can override earlier narrower deny", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    writePermissions(authorityRoot, {
      bash: {
        "git *": "deny",
        "*": "allow",
      },
    });

    expect(evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: "git remote -v" },
      authorityRoot,
    }).action).toBe("allow");

    expect(evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: "npm publish" },
      authorityRoot,
    }).action).toBe("allow");
  });
});
