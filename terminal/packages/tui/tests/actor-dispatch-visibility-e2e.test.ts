import { afterEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  __setLlmAdapterFactoryForTest,
  configureTuiRuntime,
  disposeTuiRuntimeBridge,
  getTuiRuntimeBridge,
} from "../src/runtime/bridge/TuiRuntime"

function makeTempWorkdir(): string {
  const dir = path.join(os.tmpdir(), `tui-formal-actor-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
}

function parseTrailingJson(text: string): any {
  const trimmed = String(text ?? "").trim()
  try {
    return JSON.parse(trimmed)
  } catch {}

  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start < 0 || end < start) {
    throw new Error(`No JSON object found in output: ${trimmed}`)
  }
  return JSON.parse(trimmed.slice(start, end + 1))
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("Timed out waiting for condition")
}

afterEach(() => {
  __setLlmAdapterFactoryForTest(null)
})

describe("formal actor command e2e", () => {
  it("creates a member and toggles watch state through the formal command surface", async () => {
    const sessionKey = `formal-actor-e2e-${Date.now()}`
    const workdir = makeTempWorkdir()
    configureTuiRuntime({
      workDir: workdir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { content: "idle" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge(sessionKey)
      expect(runtime).toBeTruthy()

      const created = parseTrailingJson(await runtime!.turn("/member create alice @code"))
      expect(created.ok).toBe(true)
      expect(created.member_id).toBeTruthy()
      expect(created.name).toBe("alice")

      const collective = parseTrailingJson(await runtime!.turn("/holon create autonomous research"))
      expect(collective.ok).toBe(true)
      expect(collective.governance).toBe("autonomous")
      expect(collective.name).toBe("research")

      const collectiveAdded = parseTrailingJson(await runtime!.turn("/holon add research alice"))
      expect(collectiveAdded.ok).toBe(true)
      expect(collectiveAdded.member_ids).toContain(created.member_id)

      const collectiveStatus = parseTrailingJson(await runtime!.turn("/holon status research"))
      expect(collectiveStatus.ok).toBe(true)
      expect(collectiveStatus.governance).toBe("autonomous")
      expect(collectiveStatus.name).toBe("research")
      expect(collectiveStatus.member_ids).toContain(created.member_id)

      const formation = parseTrailingJson(await runtime!.turn("/holon create leader_led alpha"))
      expect(formation.ok).toBe(true)
      expect(formation.governance).toBe("leader_led")
      expect(formation.name).toBe("alpha")

      const formationAdded = parseTrailingJson(await runtime!.turn("/holon add alpha alice"))
      expect(formationAdded.ok).toBe(true)
      expect(formationAdded.member_ids).toContain(created.member_id)

      const appointed = parseTrailingJson(await runtime!.turn("/holon appoint alpha alice"))
      expect(appointed.ok).toBe(true)
      expect(appointed.leader_member_id).toBe(created.member_id)

      const formationStatus = parseTrailingJson(await runtime!.turn("/holon status alpha"))
      expect(formationStatus.ok).toBe(true)
      expect(formationStatus.governance).toBe("leader_led")
      expect(formationStatus.name).toBe("alpha")
      expect(formationStatus.member_ids).toContain(created.member_id)
      expect(formationStatus.leader_member_id).toBe(created.member_id)

      const collectiveAssign = parseTrailingJson(await runtime!.turn("/holon assign research -- scan the repo"))
      expect(collectiveAssign.ok).toBe(true)
      expect(collectiveAssign.target_type).toBe("holon")
      expect(collectiveAssign.governance).toBe("autonomous")
      expect(collectiveAssign.holon_id).toBeTruthy()
      expect(collectiveAssign.reply_mode).toBe("final")
      expect(collectiveAssign.status).toBe("completed")
      expect(collectiveAssign.completion_status).toBe("settled")

      const formationAssign = parseTrailingJson(await runtime!.turn("/holon assign:s alpha -- implement and report progress"))
      expect(formationAssign.ok).toBe(true)
      expect(formationAssign.target_type).toBe("holon")
      expect(formationAssign.governance).toBe("leader_led")
      expect(formationAssign.holon_id).toBeTruthy()
      expect(formationAssign.leader_member_id).toBe(created.member_id)
      expect(formationAssign.reply_mode).toBe("stream")

      const assign = parseTrailingJson(await runtime!.turn("/member assign alice -- summarize the bug"))
      expect(assign.ok).toBe(true)
      expect(String(assign.target ?? "")).toContain("member:alice")
      expect(assign.member_id).toBe(created.member_id)
      expect(assign.reply_mode).toBe("final")

      const memberStatus = parseTrailingJson(await runtime!.turn("/member status alice"))
      expect(memberStatus.ok).toBe(true)
      expect(memberStatus.member_id).toBe(created.member_id)
      expect(memberStatus.name).toBe("alice")

      const watched = parseTrailingJson(await runtime!.turn("/actor watch alice"))
      expect(watched.ok).toBe(true)
      expect(watched.watch_state).toBe("watched")

      const statusWatched = parseTrailingJson(await runtime!.turn("/actor status alice"))
      expect(statusWatched.ok).toBe(true)
      expect(statusWatched.watch_state).toBe("watched")
      expect(statusWatched.identity?.kind).toBe("member")

      const unwatched = parseTrailingJson(await runtime!.turn("/actor unwatch alice"))
      expect(unwatched.ok).toBe(true)
      expect(unwatched.watch_state).toBe("unwatched")

      const actorAssign = parseTrailingJson(await runtime!.turn("/actor assign:s alice -- investigate and keep reporting progress"))
      expect(actorAssign.ok).toBe(true)
      expect(actorAssign.target).toBe("alice")
      expect(actorAssign.reply_mode).toBe("stream")
      expect(actorAssign.watch_state).toBe("watched")

      const statusUnwatched = parseTrailingJson(await runtime!.turn("/actor status alice"))
      expect(statusUnwatched.ok).toBe(true)
      expect(statusUnwatched.watch_state).toBe("watched")
    } finally {
      await disposeTuiRuntimeBridge(sessionKey)
    }
  })

  it("emits asynchronous notifications for watched member events and suppresses them after unwatch", async () => {
    const sessionKey = `formal-actor-watch-notify-${Date.now()}`
    const workdir = makeTempWorkdir()
    configureTuiRuntime({
      workDir: workdir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { content: "watched-update" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge(sessionKey)
      expect(runtime).toBeTruthy()

      const notifications: Array<{ text: string; category?: string }> = []
      const sub = runtime!.subscribeNotifications((notification) => {
        notifications.push({
          text: String(notification?.text ?? ""),
          category: notification?.category,
        })
      })

      await runtime!.turn("/member create alice @code")

      const streamAssign = parseTrailingJson(await runtime!.turn("/actor assign:s alice -- investigate and keep reporting progress"))
      expect(streamAssign.ok).toBe(true)
      expect(streamAssign.watch_state).toBe("watched")

      await waitFor(() => notifications.some((entry) => entry.text.includes("watched-update")))
      expect(notifications.some((entry) => entry.category === "assist")).toBe(true)

      notifications.length = 0

      const unwatched = parseTrailingJson(await runtime!.turn("/actor unwatch alice"))
      expect(unwatched.ok).toBe(true)
      expect(unwatched.watch_state).toBe("unwatched")

      const noneAssign = parseTrailingJson(await runtime!.turn("/member assign:n alice -- continue silently"))
      expect(noneAssign.ok).toBe(true)
      expect(noneAssign.reply_mode).toBe("none")

      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(notifications.some((entry) => entry.text.includes("watched-update"))).toBe(false)

      sub.unsubscribe()
    } finally {
      await disposeTuiRuntimeBridge(sessionKey)
    }
  })
})
