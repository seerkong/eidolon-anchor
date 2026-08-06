import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RESOURCE_VFS_ROOT,
  RUNTIME_CONFIG_VFS_PATH,
} from "@cell/symbiont-contract/resource/ResourceVFS";
import {
  ResourceVFSOps,
  normalizeVfsPath,
} from "@cell/symbiont-logic/resource/ResourceVFS";
import { ResourceVFSLoaderOps } from "@cell/symbiont-logic/resource/ResourceVFSLoader";

describe("ResourceVFSOps", () => {
  it("normalizes vfs paths to a canonical form", () => {
    expect(normalizeVfsPath("runtime-config.json")).toBe("/runtime-config.json");
    expect(normalizeVfsPath("/.eidolon/runtime-config.json")).toBe("/.eidolon/runtime-config.json");
    expect(normalizeVfsPath("/.eidolon//runtime-config.json")).toBe("/.eidolon/runtime-config.json");
    expect(normalizeVfsPath("/.eidolon/runtime-config.json/")).toBe("/.eidolon/runtime-config.json");
    expect(normalizeVfsPath(".eidolon\\runtime-config.json")).toBe("/.eidolon/runtime-config.json");
  });

  it("builds vfs from dict and reads content", () => {
    const vfs = ResourceVFSOps.fromDict({ [RUNTIME_CONFIG_VFS_PATH]: "{ \"compact\": {} }" });
    expect(ResourceVFSOps.getContent(vfs, RUNTIME_CONFIG_VFS_PATH)).toBe("{ \"compact\": {} }");
    expect(ResourceVFSOps.getContent(vfs, "/missing")).toBeUndefined();
  });

  it("merges vfs with later precedence", () => {
    const home = ResourceVFSOps.fromDict({ [RUNTIME_CONFIG_VFS_PATH]: "home" });
    const work = ResourceVFSOps.fromDict({ [RUNTIME_CONFIG_VFS_PATH]: "work" });
    const merged = ResourceVFSOps.merge(home, work);
    expect(ResourceVFSOps.getContent(merged, RUNTIME_CONFIG_VFS_PATH)).toBe("work");
  });

  it("withFile preserves source from existing file when not overridden", () => {
    const vfs = ResourceVFSOps.withFile(ResourceVFSOps.empty(), {
      path: RUNTIME_CONFIG_VFS_PATH,
      content: "a",
      source: "/src/a",
    });
    const replaced = ResourceVFSOps.withFile(vfs, { path: RUNTIME_CONFIG_VFS_PATH, content: "b" });
    expect(ResourceVFSOps.get(replaced, RUNTIME_CONFIG_VFS_PATH)?.content).toBe("b");
    expect(ResourceVFSOps.get(replaced, RUNTIME_CONFIG_VFS_PATH)?.source).toBe("/src/a");
  });

  it("exposes root and runtime config path constants", () => {
    expect(RESOURCE_VFS_ROOT).toBe("/.eidolon");
    expect(RUNTIME_CONFIG_VFS_PATH).toBe("/.eidolon/runtime-config.json");
  });
});

describe("ResourceVFSLoaderOps", () => {
  it("builds vfs from an in-memory dict", () => {
    const vfs = ResourceVFSLoaderOps.fromDict({ [RUNTIME_CONFIG_VFS_PATH]: "x" });
    expect(ResourceVFSLoaderOps.getContent(vfs, RUNTIME_CONFIG_VFS_PATH)).toBe("x");
  });

  it("loads runtime-config.json from a physical .eidolon root", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-vfs-test-"));
    const eidolonRoot = path.join(dir, ".eidolon");
    fs.mkdirSync(eidolonRoot, { recursive: true });
    fs.writeFileSync(path.join(eidolonRoot, "runtime-config.json"), `{ "compact": {} }`);

    const vfs = ResourceVFSLoaderOps.fromEidolonRoot(eidolonRoot);
    expect(ResourceVFSLoaderOps.getContent(vfs, RUNTIME_CONFIG_VFS_PATH)).toBe(`{ "compact": {} }`);
    expect(ResourceVFSOps.get(vfs, RUNTIME_CONFIG_VFS_PATH)?.source).toBe(
      path.join(eidolonRoot, "runtime-config.json"),
    );
  });

  it("returns empty vfs when .eidolon root is missing", () => {
    const vfs = ResourceVFSLoaderOps.fromEidolonRoot("/nonexistent/.eidolon");
    expect(ResourceVFSOps.listPaths(vfs)).toEqual([]);
  });

  it("merges multiple roots with later precedence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-vfs-test-"));
    const homeRoot = path.join(dir, "home", ".eidolon");
    const workRoot = path.join(dir, "work", ".eidolon");
    fs.mkdirSync(homeRoot, { recursive: true });
    fs.mkdirSync(workRoot, { recursive: true });
    fs.writeFileSync(path.join(homeRoot, "runtime-config.json"), `"home"`);
    fs.writeFileSync(path.join(workRoot, "runtime-config.json"), `"work"`);

    const vfs = ResourceVFSLoaderOps.fromEidolonRoots([homeRoot, workRoot]);
    expect(ResourceVFSLoaderOps.getContent(vfs, RUNTIME_CONFIG_VFS_PATH)).toBe(`"work"`);
  });
});
