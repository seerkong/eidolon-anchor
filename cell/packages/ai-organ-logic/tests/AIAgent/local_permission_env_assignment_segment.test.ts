/**
 * Regression coverage for environment-assignment-only bash segments.
 *
 * `D=/path` as its own `&&` segment is a legal POSIX shell command (a pure
 * assignment, exit status 0). The segment tokenizer previously treated "no
 * executable word left after skipping leading assignments" as a parse failure
 * and threw `Bash segment does not contain an executable command`, which
 * rejected the whole command. That false negative made an agent retry a
 * correct command until its turn never converged.
 *
 * These tests pin the legal cases AND the guards that must not weaken:
 * protected permission-config writes and dangerous commands stay denied.
 */
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "organ-local-permission-env-"));
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

describe("environment assignment segments are legal", () => {
  it("parses a leading assignment segment followed by a command", () => {
    expect(parseBashCommandSegments("A=1 && echo hi")).toEqual(["A=1", "echo hi"]);
  });

  it("parses an assignment segment in the middle of a chain", () => {
    // Segment normalization strips quoting, matching the existing contract
    // asserted for `printf ";"` → `printf ;`.
    expect(parseBashCommandSegments('cd /tmp/x && D=/tmp/y && tar -xzf "$D/a.tgz"'))
      .toEqual(["cd /tmp/x", "D=/tmp/y", "tar -xzf $D/a.tgz"]);
  });

  it("parses the real-world pinned-tarball extraction shape", () => {
    const command = 'cd /tmp/work && rm -rf extract && D=/pinned/round-44 '
      + '&& tar -xzf "$D/a.tgz" -C extract && echo extracted';
    expect(() => parseBashCommandSegments(command)).not.toThrow();
    expect(parseBashCommandSegments(command)).toEqual([
      "cd /tmp/work",
      "rm -rf extract",
      "D=/pinned/round-44",
      "tar -xzf $D/a.tgz -C extract",
      "echo extracted",
    ]);
  });

  it("parses a command that is only assignments", () => {
    expect(parseBashCommandSegments("A=1 B=2")).toEqual(["A=1 B=2"]);
  });

  it("still rejects a genuinely malformed command with an empty segment", () => {
    expect(() => parseBashCommandSegments("echo hi && && echo bye")).toThrow();
  });

  it("evaluates an assignment-only command as having no side effects", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    writePermissions(authorityRoot, { bash: { "*": "deny" } });

    // A pure assignment runs nothing, so no rule needs to approve it.
    expect(evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: "D=/tmp/pinned" },
      authorityRoot,
    }).action).toBe("allow");
  });

  it("still requires approval for the real command in an assignment chain", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    // A rule set with no broad fallback: the real command has no matching
    // allow, so the segment must still be denied even though an assignment
    // segment precedes it. (With a broad `*: allow` the existing
    // "last matching rule wins" contract would legitimately allow it — that
    // behavior is covered elsewhere and is not what this test is about.)
    writePermissions(authorityRoot, { bash: { "git *": "allow" } });

    const result = evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: 'D=/pinned && tar -xzf "$D/a.tgz"' },
      authorityRoot,
    });
    expect(result.action).toBe("deny");
    expect(result.message).toContain("tar");
  });

  it("still refuses to modify the protected permission config through an assignment chain", () => {
    configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
    const root = makeTempRoot();
    const workDir = path.join(root, "workspace");
    const authorityRoot = path.join(root, ".eidolon");
    fs.mkdirSync(workDir, { recursive: true });
    writePermissions(authorityRoot, { bash: { "*": "allow" } });

    expect(() => evaluateLocalToolPermission({
      workDir,
      toolName: "bash",
      payload: { command: 'A=1 && printf "{}" > ' + path.join(authorityRoot, "permissions.json") },
      authorityRoot,
    })).toThrow(/permission/i);
  });
});
