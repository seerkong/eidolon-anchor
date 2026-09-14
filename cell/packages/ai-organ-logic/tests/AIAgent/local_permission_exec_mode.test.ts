import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { configureLocalPermissionConfigStore } from "@cell/ai-organ-logic";
import { LocalFilePermissionConfigStore } from "@cell/ai-support";
import { authorizeLocalToolCall } from "@cell/ai-organ-logic/permissions/LocalPermissionRuntime";

const tempRoots: string[] = [];

configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "organ-local-permission-exec-"));
  tempRoots.push(root);
  return root;
}

function buildPermissionSandbox(): {
  workDir: string;
  authorityRoot: string;
  externalDir: string;
  externalFile: string;
} {
  const root = makeTempRoot();
  const workDir = path.join(root, "workspace");
  const authorityRoot = path.join(root, ".eidolon");
  const externalDir = path.join(root, "outside");
  const externalFile = path.join(externalDir, "secret.txt");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(authorityRoot, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "secret.txt"), "secret");
  fs.writeFileSync(externalFile, "outer-secret");
  fs.writeFileSync(
    path.join(authorityRoot, "permissions.json"),
    JSON.stringify(
      {
        permission: {
          "*": "deny",
          read: {
            "secret.txt": "ask",
          },
        },
      },
      null,
      2,
    ),
  );
  return { workDir, authorityRoot, externalDir, externalFile };
}

function buildRuntime(params: {
  workDir: string;
  authorityRoot: string;
  mode: "default" | "full-auto" | "dangerous";
  additionalWritableRoots?: string[];
}): any {
  return {
    vm: {
      outerCtx: {
        workDir: params.workDir,
        metadata: {
          local_permissions: {
            authority_root: params.authorityRoot,
          },
          exec_protocol: {
            mode: params.mode,
            additional_writable_roots: params.additionalWritableRoots ?? [],
          },
        },
      },
    },
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("local permission exec modes", () => {
  test("default exec fails closed on ask decisions", () => {
    const { workDir, authorityRoot } = buildPermissionSandbox();

    const result = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "default" }),
      "read",
      { filePath: "secret.txt" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.output).toContain("local permission requires approval");
    }
  });

  test("full-auto auto-approves local ask and external reads under the unified mode behaviour", () => {
    const { workDir, authorityRoot, externalFile } = buildPermissionSandbox();

    const localAsk = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "full-auto" }),
      "read",
      { filePath: "secret.txt" },
    );
    expect(localAsk).toEqual({ ok: true });

    // full-auto and dangerous now share one behaviour: leaving the workspace is
    // not itself a boundary. Only writing the protected permission config is.
    const externalRead = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "full-auto" }),
      "read",
      { filePath: externalFile, scopeIntent: "external" },
    );
    expect(externalRead).toEqual({ ok: true });
  });

  test("unsupported bash syntax follows approval semantics instead of surfacing parser errors", () => {
    const { workDir, authorityRoot } = buildPermissionSandbox();
    fs.writeFileSync(
      path.join(authorityRoot, "permissions.json"),
      JSON.stringify({ permission: { "*": "ask" } }, null, 2),
    );
    const command = "for f in $(find . -name 'step-config-def.json' | sort); do echo \"$f\"; done";

    const defaultMode = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "default" }),
      "bash",
      { command },
    );
    expect(defaultMode.ok).toBe(false);
    if (!defaultMode.ok) {
      expect(defaultMode.output).toContain("unsupported bash syntax");
    }

    const fullAutoMode = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "full-auto" }),
      "bash",
      { command },
    );
    expect(fullAutoMode).toEqual({ ok: true });
  });

  test("dangerous mode bypasses normal denials but still protects permission config files", () => {
    const { workDir, authorityRoot, externalFile } = buildPermissionSandbox();

    const deniedRead = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "dangerous" }),
      "read",
      { filePath: "secret.txt" },
    );
    expect(deniedRead).toEqual({ ok: true });

    const externalGrant = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "dangerous" }),
      "write",
      { filePath: externalFile, scopeIntent: "external" },
    );
    expect(externalGrant).toEqual({ ok: true });

    const protectedWrite = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "dangerous" }),
      "write",
      { filePath: path.join(authorityRoot, "permissions.json") },
    );
    expect(protectedWrite.ok).toBe(false);
    if (!protectedWrite.ok) {
      expect(protectedWrite.output).toContain("Protected local permission config path");
    }

    const protectedBashWrite = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "dangerous" }),
      "bash",
      { command: `echo $(printf hi > ${path.join(authorityRoot, "permissions.json")})` },
    );
    expect(protectedBashWrite.ok).toBe(false);
    if (!protectedBashWrite.ok) {
      expect(protectedBashWrite.output).toContain("Protected local permission config path");
    }
  });

  test("additional writable roots extend the exec write boundary", () => {
    const { workDir, authorityRoot, externalDir, externalFile } = buildPermissionSandbox();

    const result = authorizeLocalToolCall(
      buildRuntime({
        workDir,
        authorityRoot,
        mode: "default",
        additionalWritableRoots: [externalDir],
      }),
      "write",
      { filePath: externalFile, scopeIntent: "external" },
    );

    expect(result).toEqual({ ok: true });
  });

  test("dangerous mode may read a workspace-scoped parent path under the unified behaviour", () => {
    const { workDir, authorityRoot } = buildPermissionSandbox();
    const result = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "dangerous" }),
      "ls",
      { path: path.dirname(workDir) },
    );

    // The unified mode behaviour does not treat leaving the workspace as a
    // boundary; only writing the protected permission config is withheld.
    expect(result).toEqual({ ok: true });
  });
});

describe("unified dangerous and full-auto behaviour", () => {
  test("dangerous mode reads files under the authority root", () => {
    const { workDir, authorityRoot } = buildPermissionSandbox();
    fs.mkdirSync(path.join(authorityRoot, "skills", "depa-codument"), { recursive: true });
    const skillFile = path.join(authorityRoot, "skills", "depa-codument", "SKILL.md");
    fs.writeFileSync(skillFile, "# skill");

    // The agent must be able to consume its own installed skills instead of
    // failing closed on a path that only leaves the business workspace.
    const result = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "dangerous" }),
      "read",
      { filePath: skillFile },
    );

    expect(result).toEqual({ ok: true });
  });

  test("dangerous mode may read outside the authority root", () => {
    const { workDir, authorityRoot, externalFile } = buildPermissionSandbox();

    // Under the unified mode behaviour, only the protected write list is a
    // boundary; a read outside the authority root is allowed.
    const result = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "dangerous" }),
      "read",
      { filePath: externalFile },
    );

    expect(result).toEqual({ ok: true });
  });

  test("dangerous mode still protects the permission config from writes", () => {
    const { workDir, authorityRoot } = buildPermissionSandbox();
    const permissionFile = path.join(authorityRoot, "permissions.json");

    // The permission config is the one write path that must stay protected
    // even under --yolo (covered jointly for both modes below).
    const result = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "dangerous" }),
      "write",
      { filePath: permissionFile, content: "{}" },
    );

    expect(result.ok).toBe(false);
  });

  test("full-auto also reads the authority root under the unified behaviour", () => {
    const { workDir, authorityRoot } = buildPermissionSandbox();
    fs.mkdirSync(path.join(authorityRoot, "skills"), { recursive: true });
    const skillFile = path.join(authorityRoot, "skills", "SKILL.md");
    fs.writeFileSync(skillFile, "# skill");

    // The two modes are unified, so full-auto gains the same authority-root
    // read access that dangerous has.
    const result = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "full-auto" }),
      "read",
      { filePath: skillFile },
    );

    expect(result).toEqual({ ok: true });
  });

  test("both modes still refuse writing the protected permission config", () => {
    const { workDir, authorityRoot } = buildPermissionSandbox();
    const permissionFile = path.join(authorityRoot, "permissions.json");
    const workspaceAccessFile = path.join(authorityRoot, "workspace-access.json");

    for (const mode of ["dangerous", "full-auto"] as const) {
      for (const target of [permissionFile, workspaceAccessFile]) {
        const result = authorizeLocalToolCall(
          buildRuntime({ workDir, authorityRoot, mode }),
          "write",
          { filePath: target, content: "{}" },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.output).toContain("Protected local permission config path");
        }
      }
    }
  });
});
