import path from "node:path"
import os from "node:os"

import { describe, expect, it } from "bun:test"

import {
  buildExecRuntimeMetadata,
  normalizeTerminalRuntimeMetadata,
  resolveRuntimeAuthorityRoot,
} from "@terminal/organ/AIAgent/TerminalRuntime"

describe("TerminalRuntime metadata normalization", () => {
  it("defaults local permission authority root to the home .eidolon directory", () => {
    const workDir = "/tmp/demo-workspace"
    const authorityRoot = path.join(path.resolve(process.env.HOME || process.env.USERPROFILE || os.homedir()), ".eidolon")
    expect(resolveRuntimeAuthorityRoot(workDir)).toBe(authorityRoot)
    expect(normalizeTerminalRuntimeMetadata(workDir)).toEqual({
      local_permissions: {
        authority_root: authorityRoot,
      },
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

    expect(metadata).toEqual({
      local_permissions: {
        authority_root: authorityRoot,
      },
      sandbox_permissions: {
        custom_flag: "keep-me",
        sandbox_mode: "workspace-write",
        network_access: "enabled",
        approval_policy: "never",
      },
      exec_protocol: {
        mode: "full-auto",
        additional_writable_roots: ["/tmp/shared-a", "/tmp/shared-b"],
        ephemeral: true,
      },
    })
  })
})
