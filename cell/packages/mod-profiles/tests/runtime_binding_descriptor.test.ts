import { describe, expect, it } from "bun:test"

import {
  buildRuntimeBindingDescriptor,
  areRuntimeBindingDescriptorsCompatible,
  type RuntimeBindingDescriptor,
  type RuntimeEntryType,
} from "@cell/ai-composer"
import {
  aiCodingRuntimeProfile,
  aiKernelRuntimeProfile,
  platformOnlyRuntimeProfile,
} from "../src"

const context = {
  workDir: "/tmp/binding-descriptor-test",
  skillsDescription: "",
  loadedAgents: {},
  delegateAgentDescriptions: "",
}

function buildForEntry(entryType: RuntimeEntryType): RuntimeBindingDescriptor {
  return buildRuntimeBindingDescriptor({
    profile: aiCodingRuntimeProfile,
    context,
    entryType,
    storage: { logs: true, files: true },
  })
}

describe("runtime binding descriptor", () => {
  it("describes the selected profile, capabilities, storage flags, modules, and overlays", () => {
    const descriptor = buildForEntry("cli")
    expect(descriptor.profileId).toBe("ai-coding")
    expect(descriptor.entryType).toBe("cli")
    expect(descriptor.storage).toEqual({ logs: true, files: true })
    expect(descriptor.platformModules).toContain("mod-platform-kernel")
    expect(descriptor.domainKernelModules).toContain("mod-ai-kernel")
    expect(descriptor.appOverlays).toContain("mod-ai-coding")
    expect(descriptor.enabledCapabilities.length).toBeGreaterThan(0)
  })

  it("same profile produces compatible descriptors across cli, tui, and headless entries", () => {
    const cli = buildForEntry("cli")
    const tui = buildForEntry("tui")
    const headless = buildForEntry("headless")

    expect(areRuntimeBindingDescriptorsCompatible(cli, tui)).toBe(true)
    expect(areRuntimeBindingDescriptorsCompatible(cli, headless)).toBe(true)
    expect(areRuntimeBindingDescriptorsCompatible(tui, headless)).toBe(true)

    expect(tui.profileId).toBe(cli.profileId)
    expect(tui.enabledCapabilities).toEqual(cli.enabledCapabilities)
    expect(tui.storage).toEqual(cli.storage)
    expect(tui.platformModules).toEqual(cli.platformModules)
    expect(tui.domainKernelModules).toEqual(cli.domainKernelModules)
    expect(tui.appOverlays).toEqual(cli.appOverlays)
  })

  it("different profiles produce incompatible descriptors", () => {
    const coding = buildForEntry("cli")
    const kernelOnly = buildRuntimeBindingDescriptor({
      profile: aiKernelRuntimeProfile,
      context,
      entryType: "cli",
      storage: { logs: true, files: true },
    })
    expect(areRuntimeBindingDescriptorsCompatible(coding, kernelOnly)).toBe(false)
  })

  it("different storage flags produce incompatible descriptors", () => {
    const persistent = buildForEntry("cli")
    const memoryOnly = buildRuntimeBindingDescriptor({
      profile: aiCodingRuntimeProfile,
      context,
      entryType: "cli",
      storage: { logs: false, files: false },
    })
    expect(areRuntimeBindingDescriptorsCompatible(persistent, memoryOnly)).toBe(false)
  })

  it("platform-only profile has no AI domain modules or overlays", () => {
    const descriptor = buildRuntimeBindingDescriptor({
      profile: platformOnlyRuntimeProfile,
      context,
      entryType: "headless",
      storage: { logs: false, files: false },
    })
    expect(descriptor.profileId).toBe("platform-only")
    expect(descriptor.platformModules).toEqual(["mod-platform-kernel"])
    expect(descriptor.domainKernelModules).toEqual([])
    expect(descriptor.appOverlays).toEqual([])
  })
})
