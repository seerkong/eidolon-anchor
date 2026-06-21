/**
 * P3 (track isolate-runtime-projection-surfaces) — surface session destroy goes
 * through the domain-owned delete capability, not a direct surface `rm` of the
 * session truth dir.
 *
 * Behavior-delta requirement `surface-destroy-via-domain-capability`, case
 * `session-delete-routes-through-capability`:
 *  - SOURCE-LEVEL: TuiRuntimeClient.ts `session.delete` no longer calls
 *    `rm(getSessionDir(...))` on the session truth dir; it routes through the
 *    domain delete capability `deleteFileStoreAiRuntimeSession` imported from
 *    `@cell/ai-runtime-control-composer` (alongside the upgrade capabilities).
 *  - BEHAVIORAL: deleting a local-runtime session removes the truth dir (the
 *    domain capability owns the removal) and still emits the `session.deleted`
 *    event — user-visible delete semantics unchanged.
 */
import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Event } from "@terminal/core/AIAgent"
import { createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

const TUI_RUNTIME_CLIENT_SOURCE = path.join(
  import.meta.dir,
  "..",
  "src",
  "runtime",
  "client",
  "TuiRuntimeClient.ts",
)

function readClientSource(): string {
  return fs.readFileSync(TUI_RUNTIME_CLIENT_SOURCE, "utf8")
}

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("TuiRuntimeClient session.delete via domain capability", () => {
  it("source: session.delete no longer rm's the session truth dir directly", () => {
    const source = readClientSource()
    // The Rule-5 violation was a direct surface fs removal of the session truth
    // dir. After P3 the surface must not call rm on getSessionDir(...) anywhere.
    expect(source).not.toMatch(/rm\(\s*getSessionDir\(/)
  })

  it("source: delete routes through the domain-owned delete capability", () => {
    const source = readClientSource()
    expect(source).toContain("deleteFileStoreAiRuntimeSession")
    // Imported from the same domain composer that owns the upgrade capabilities.
    expect(source).toMatch(
      /deleteFileStoreAiRuntimeSession[\s\S]*?from\s+"@cell\/ai-runtime-control-composer"/,
    )
    // The capability is invoked with the session dir in the delete path.
    expect(source).toMatch(/deleteFileStoreAiRuntimeSession\(\s*\{\s*sessionDir:\s*getSessionDir\(/)
  })

  it("behavioral: deleting a local-runtime session removes the truth dir and emits session.deleted", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tui-session-delete-"))
    tmpDirs.push(directory)
    const sessionID = "session-delete-cap"

    // Materialize a representative session truth tree under the surface directory.
    const sessionDir = path.join(directory, ".eidolon", "sessions", sessionID)
    fs.mkdirSync(path.join(sessionDir, "conversation"), { recursive: true })
    fs.writeFileSync(
      path.join(sessionDir, "conversation", "session.index.json"),
      JSON.stringify({ version: 1 }),
    )
    fs.writeFileSync(path.join(sessionDir, "tui-session.json"), JSON.stringify({ title: "x" }))
    expect(fs.existsSync(sessionDir)).toBe(true)

    const sdk = createTuiRuntimeClient({ mode: "local-runtime", directory })
    const events: Event[] = []
    const unsub = sdk.event.on((event) => events.push(event))

    try {
      const result = await sdk.client.session.delete({ sessionID })
      expect(result.data).toBe(true)

      // The session truth dir is gone (capability owns the removal).
      expect(fs.existsSync(sessionDir)).toBe(false)

      // The user-visible delete event still fires.
      const deleted = events.filter((event) => event.type === "session.deleted")
      expect(deleted.length).toBeGreaterThan(0)
      expect((deleted.at(-1) as any).properties?.info?.id).toBe(sessionID)
    } finally {
      unsub()
    }
  })
})
