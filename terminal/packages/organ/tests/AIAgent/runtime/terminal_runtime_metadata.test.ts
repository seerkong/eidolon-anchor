import path from "node:path"
import os from "node:os"

import { describe, expect, it } from "bun:test"

import {
  buildExecRuntimeMetadata,
  buildSystemMessages,
  normalizeTerminalRuntimeMetadata,
  resolveRuntimeAuthorityRoot,
  resolveRuntimeResourcePackageLayers,
} from "@terminal/organ/AIAgent/TerminalRuntime"

describe("TerminalRuntime metadata normalization", () => {
  it("defaults local permission authority root to the home .eidolon directory", () => {
    const workDir = "/tmp/demo-workspace"
    const authorityRoot = path.join(path.resolve(process.env.HOME || process.env.USERPROFILE || os.homedir()), ".eidolon")
    expect(resolveRuntimeAuthorityRoot(workDir)).toBe(authorityRoot)
    const metadata = normalizeTerminalRuntimeMetadata(workDir)
    expect(metadata.local_permissions).toEqual({
      authority_root: authorityRoot,
    })
    expect(resolveRuntimeResourcePackageLayers(workDir, authorityRoot)).toEqual([
      { id: "global", rootDir: path.join(authorityRoot, "resources") },
      { id: "workspace", rootDir: path.join(path.resolve(workDir), ".eidolon", "resources") },
    ])
    expect(metadata.resourcePackages).toEqual({
      layers: resolveRuntimeResourcePackageLayers(workDir, authorityRoot),
    })
    expect((metadata.aiWorkflow as any).roots.workspaceRoot).toBe(
      path.join(path.resolve(workDir), ".eidolon", "workflows"),
    )
    // Assert the injected platform defaults without binding to the user's local
    // runtime-config.json (which may or may not exist in ~/.eidolon).
    expect(metadata.platform).toBe(process.platform)
    expect(metadata.sandbox_permissions).toMatchObject({
      sandbox_mode: "workspace-write",
      network_access: "enabled",
      approval_policy: "full-auto",
    })
    if (process.platform === "win32") {
      expect(metadata.exec_protocol).toMatchObject({ mode: "full-auto" })
    } else {
      // Non-Windows keeps the interactive default by not injecting a mode.
      expect((metadata.exec_protocol as any).mode).toBeUndefined()
    }
  })

  it("injects platform defaults when the entry passes no metadata", () => {
    const metadata = normalizeTerminalRuntimeMetadata("/tmp/demo-workspace")
    expect(metadata.platform).toBe(process.platform)
    expect(metadata.sandbox_permissions).toMatchObject({
      sandbox_mode: "workspace-write",
      network_access: "enabled",
      approval_policy: "full-auto",
    })
    if (process.platform === "win32") {
      expect(metadata.exec_protocol).toMatchObject({ mode: "full-auto" })
    } else {
      expect((metadata.exec_protocol as any).mode).toBeUndefined()
    }
  })

  it("preserves explicit metadata over injected defaults", () => {
    const metadata = normalizeTerminalRuntimeMetadata("/tmp/demo-workspace", {
      platform: "linux",
      sandbox_permissions: { sandbox_mode: "read-only" },
      exec_protocol: { mode: "dangerous" },
      resourcePackages: {
        layers: [{ id: "workspace", rootDir: "/opt/eidolon/resources" }],
      },
    })
    expect(metadata.platform).toBe("linux")
    expect(metadata.sandbox_permissions.sandbox_mode).toBe("read-only")
    expect(metadata.exec_protocol.mode).toBe("dangerous")
    expect(metadata.resourcePackages).toEqual({
      layers: [{ id: "workspace", rootDir: "/opt/eidolon/resources" }],
    })
  })

  it("builds exec metadata on top of shared runtime defaults", () => {
    const workDir = "/tmp/demo-workspace"
    const authorityRoot = path.join(path.resolve(process.env.HOME || process.env.USERPROFILE || os.homedir()), ".eidolon")
    const metadata = buildExecRuntimeMetadata({
      workDir,
      approvalMode: "full-auto",
      additionalWritableRoots: ["/tmp/shared-a", "/tmp/shared-b"],
      ephemeral: true,
      metadata: {
        sandbox_permissions: {
          custom_flag: "keep-me",
        },
      },
    })

    expect(metadata.platform).toBe(process.platform)
    expect(metadata.local_permissions).toEqual({
      authority_root: authorityRoot,
    })
    expect(metadata.sandbox_permissions).toMatchObject({
      custom_flag: "keep-me",
      sandbox_mode: "workspace-write",
      network_access: "enabled",
      approval_policy: "never",
    })
    expect(metadata.exec_protocol).toMatchObject({
      mode: "full-auto",
      additional_writable_roots: ["/tmp/shared-a", "/tmp/shared-b"],
      ephemeral: true,
    })
  })
})

describe("buildSystemMessages platform injection", () => {
  it("appends a platform block to the system messages", () => {
    const messages = buildSystemMessages(["system instruction one", "system instruction two"])
    expect(messages.length).toBe(3)
    expect(messages[0].role).toBe("system")
    expect(messages[2].role).toBe("system")
    expect(messages[2].content).toContain("Current platform")
    expect(messages[2].content).toContain("Shell:")
    expect(messages[2].content).toContain(process.platform)
  })

  it("keeps the original prompt messages intact", () => {
    const messages = buildSystemMessages(["original prompt"])
    expect(messages[0]).toEqual({ role: "system", content: "original prompt" })
  })
})
