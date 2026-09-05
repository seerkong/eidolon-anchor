import { describe, expect, it, spyOn } from "bun:test";
import {
  parseLocalPermissionsConfig,
  parseWorkspaceAccessConfig,
} from "../src/permissions/LocalPermissionRules";

describe("explicit permission rule inputs", () => {
  it("uses only the supplied absolute cwd for relative paths", () => {
    const cwd = spyOn(process, "cwd").mockImplementation(() => { throw new Error("implicit cwd read"); });
    try {
      expect(parseLocalPermissionsConfig({ overrides: [{ directory: "relative", permission: {} }] }, "config", "/first").overrides[0]?.directory)
        .toBe("/first/relative");
      expect(parseLocalPermissionsConfig({ overrides: [{ directory: "/absolute", permission: {} }] }, "config", "/second").overrides[0]?.directory)
        .toBe("/absolute");
      expect(parseWorkspaceAccessConfig({ workspaces: { project: { entries: [{ path: "../outside", permissions: ["write", "read", "write"] }] } } }, "config", "/first"))
        .toEqual({ workspaces: { "/first/project": [{ path: "/outside", permissions: new Set(["write", "read"]) }] } });
      expect(cwd).not.toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
    }
  });

  it("rejects a relative cwd instead of silently depending on process state", () => {
    expect(() => parseLocalPermissionsConfig({}, "config", "relative")).toThrow("absolute cwd");
    expect(() => parseWorkspaceAccessConfig({}, "config", "relative")).toThrow("absolute cwd");
  });
});
