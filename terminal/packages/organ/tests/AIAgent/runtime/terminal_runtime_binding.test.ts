import { describe, expect, it } from "bun:test"

import { areRuntimeCompositionBindingDescriptorsCompatible as areRuntimeBindingDescriptorsCompatible } from "@cell/membrane/runtime-composition"
import {
  composeTerminalRuntimeBinding,
  resolveTerminalRuntimeBindingFromConfig,
} from "../../../src/AIAgent/TerminalRuntime"

const workDir = "/tmp/terminal-runtime-binding-test"

describe("composeTerminalRuntimeBinding", () => {
  it("builds a binding descriptor for the default ai-coding profile", () => {
    const binding = composeTerminalRuntimeBinding({
      workDir,
      entryType: "cli",
    })
    expect(binding.descriptor.profileId).toBe("ai-coding")
    expect(binding.descriptor.entryType).toBe("cli")
    expect(binding.descriptor.appOverlays).toContain("mod-ai-coding")
    expect(binding.profile.id).toBe("ai-coding")
  })

  it("cli, tui, and headless entries produce compatible descriptors for the same profile", () => {
    const cli = composeTerminalRuntimeBinding({ workDir, entryType: "cli" })
    const tui = composeTerminalRuntimeBinding({ workDir, entryType: "tui" })
    const headless = composeTerminalRuntimeBinding({ workDir, entryType: "headless" })

    expect(areRuntimeBindingDescriptorsCompatible(cli.descriptor, tui.descriptor)).toBe(true)
    expect(areRuntimeBindingDescriptorsCompatible(cli.descriptor, headless.descriptor)).toBe(true)
    expect(cli.descriptor.entryType).toBe("cli")
    expect(tui.descriptor.entryType).toBe("tui")
    expect(headless.descriptor.entryType).toBe("headless")
  })

  it("selects a profile by id and rejects unknown profile ids", () => {
    const kernel = composeTerminalRuntimeBinding({
      workDir,
      entryType: "headless",
      profileId: "ai-kernel",
    })
    expect(kernel.descriptor.profileId).toBe("ai-kernel")
    expect(kernel.descriptor.appOverlays).toEqual([])

    expect(() =>
      composeTerminalRuntimeBinding({ workDir, entryType: "cli", profileId: "no-such-profile" }),
    ).toThrow(/no-such-profile/)
  })

  it("entry runtime config resolves through the same shared binding path", () => {
    const defaulted = resolveTerminalRuntimeBindingFromConfig({ workDir })
    expect(defaulted.descriptor.profileId).toBe("ai-coding")
    expect(defaulted.descriptor.entryType).toBe("headless")
    expect(defaulted.descriptor.storage).toEqual({ logs: true, files: true })

    const configured = resolveTerminalRuntimeBindingFromConfig({
      workDir,
      profileId: "ai-kernel",
      entryType: "tui",
      storage: { logs: false, files: false },
    })
    expect(configured.descriptor.profileId).toBe("ai-kernel")
    expect(configured.descriptor.entryType).toBe("tui")
    expect(configured.descriptor.storage).toEqual({ logs: false, files: false })
  })

  it("storage flags flow into the descriptor and default to persistent", () => {
    const persistent = composeTerminalRuntimeBinding({ workDir, entryType: "cli" })
    expect(persistent.descriptor.storage).toEqual({ logs: true, files: true })

    const memoryOnly = composeTerminalRuntimeBinding({
      workDir,
      entryType: "cli",
      storage: { logs: false, files: false },
    })
    expect(memoryOnly.descriptor.storage).toEqual({ logs: false, files: false })
    expect(areRuntimeBindingDescriptorsCompatible(persistent.descriptor, memoryOnly.descriptor)).toBe(false)
  })
})
