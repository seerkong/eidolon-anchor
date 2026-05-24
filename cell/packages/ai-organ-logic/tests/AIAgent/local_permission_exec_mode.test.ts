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

  test("full-auto auto-approves local ask but still blocks workspace grant requests", () => {
    const { workDir, authorityRoot, externalFile } = buildPermissionSandbox();

    const localAsk = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "full-auto" }),
      "read",
      { filePath: "secret.txt" },
    );
    expect(localAsk).toEqual({ ok: true });

    const externalGrant = authorizeLocalToolCall(
      buildRuntime({ workDir, authorityRoot, mode: "full-auto" }),
      "read",
      { filePath: externalFile },
    );
    expect(externalGrant.ok).toBe(false);
    if (!externalGrant.ok) {
      expect(externalGrant.output).toContain("workspace access grant required");
    }
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
      { filePath: externalFile },
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
      { filePath: externalFile },
    );

    expect(result).toEqual({ ok: true });
  });
});
