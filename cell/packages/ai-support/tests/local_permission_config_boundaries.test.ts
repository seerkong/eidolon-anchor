import { afterEach, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  parseLocalPermissionsConfig,
  parseWorkspaceAccessConfig,
  resolveRequestedPath,
  serializeWorkspaceAccessConfig,
  workspaceAccessGrantRoot,
} from "@cell/ai-organ-logic/permissions/LocalPermissionConfig";
import { LocalFilePermissionConfigStore } from "../src/permissions/LocalFilePermissionConfigStore";
import * as physicalPaths from "../src/permissions/LocalPermissionPaths";
import { serializeWorkspaceAccessConfig as serializeWorkspaceAccessRules } from "@cell/ai-core-logic/permissions/LocalPermissionRules";

const originalCwd = process.cwd();
const roots: string[] = [];
function temporaryDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-boundaries-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  process.chdir(originalCwd);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("local permission configuration compatibility", () => {
  it("resolves relative paths against each invocation cwd, not the authority file directory", () => {
    const authorityRoot = temporaryDirectory();
    const cwdA = temporaryDirectory();
    const cwdB = temporaryDirectory();
    const permissions = { overrides: [{ directory: "relative", permission: { read: "allow" } }] };
    const access = { workspaces: { project: { entries: [{ path: "outside", permissions: ["read"] }] } } };
    fs.writeFileSync(path.join(authorityRoot, "permissions.json"), JSON.stringify(permissions));
    fs.writeFileSync(path.join(authorityRoot, "workspace-access.json"), JSON.stringify(access));
    for (const cwd of [cwdA, cwdB]) {
      process.chdir(cwd);
      const resolvedCwd = process.cwd();
      expect(parseLocalPermissionsConfig(permissions, "/unrelated/config.json").overrides[0]?.directory)
        .toBe(path.join(resolvedCwd, "relative"));
      const expected = { workspaces: { [path.join(resolvedCwd, "project")]: [{ path: path.join(resolvedCwd, "outside"), permissions: new Set(["read"]) }] } };
      expect(parseWorkspaceAccessConfig(access, "/unrelated/config.json")).toEqual(expected);
      expect(LocalFilePermissionConfigStore.loadWorkspaceAccessConfig(authorityRoot)).toEqual(expected);
      expect(LocalFilePermissionConfigStore.loadLocalPermissionsConfig(authorityRoot).overrides[0]?.directory)
        .toBe(path.join(resolvedCwd, "relative"));
    }
  });

  it("preserves wildcard precedence, action normalization, absolute paths and serialized ordering", () => {
    expect(parseLocalPermissionsConfig({ permission: { bash: { "git *": " ALLOW " }, "*": "deny" }, overrides: [{ directory: "/stable/root", permission: {} }] }, "config")).toEqual({
      rules: [{ permission: "*", pattern: "*", action: "deny" }, { permission: "bash", pattern: "git *", action: "allow" }],
      overrides: [{ directory: "/stable/root", rules: [] }],
    });
    expect(serializeWorkspaceAccessConfig({ workspaces: {
      "/z": [{ path: "/outside/z", permissions: new Set(["write", "read"]) }],
      "/a": [],
    } })).toEqual({ workspaces: { "/a": { entries: [] }, "/z": { entries: [{ path: "/outside/z", permissions: ["read", "write"] }] } } });
    expect(() => parseLocalPermissionsConfig({ z: 1, a: 2 }, "config")).toThrow("Unknown fields in config: a, z");
    expect(() => parseWorkspaceAccessConfig({ workspaces: { a: { entries: [{ path: "b", permissions: ["execute"] }] } } }, "config"))
      .toThrow("Workspace 'a' entry 0 in config has invalid permission: execute");
  });

  it("retains directory/file grant roots, permission widening and newline-terminated authority bytes", () => {
    const root = temporaryDirectory();
    const authorityRoot = path.join(root, "authority");
    const directory = path.join(root, "outside");
    fs.mkdirSync(directory);
    const workDir = path.join(root, "workspace");
    expect(LocalFilePermissionConfigStore.grantWorkspaceAccess({ authorityRoot, workDir, targetPath: directory, accessKind: "read" })).toBe(directory);
    expect(LocalFilePermissionConfigStore.grantWorkspaceAccess({ authorityRoot, workDir, targetPath: path.join(directory, "future.txt"), accessKind: "write" })).toBe(directory);
    expect(LocalFilePermissionConfigStore.loadWorkspaceAccessConfig(authorityRoot)).toEqual({ workspaces: { [workDir]: [{ path: directory, permissions: new Set(["read", "write"]) }] } });
    const bytes = fs.readFileSync(path.join(authorityRoot, "workspace-access.json"), "utf8");
    expect(bytes).toBe(`${JSON.stringify({ workspaces: { [workDir]: { entries: [{ path: directory, permissions: ["read", "write"] }] } } }, null, 2)}\n`);
  });

  it("keeps compatibility exports bound to the same rule and physical implementations", () => {
    expect(serializeWorkspaceAccessConfig).toBe(serializeWorkspaceAccessRules);
    expect(resolveRequestedPath).toBe(physicalPaths.resolveRequestedPath);
    expect(workspaceAccessGrantRoot).toBe(physicalPaths.workspaceAccessGrantRoot);
    const previousHome = process.env.HOME;
    try {
      for (const home of ["/first-home", "/second-home"]) {
        process.env.HOME = home;
        expect(resolveRequestedPath("/workspace", "~/file.txt")).toBe(`${home}/file.txt`);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
