import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openHostSessionRegistry } from "../../cell/packages/ai-runtime-host-support/src/sessionRegistry"

test("session identity and bootstrap idempotency survive reopening without storing runtime or credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anchor-registry-"))
  let registry = openHostSessionRegistry(directory)
  const session = { sessionId: "s1", storageKey: "opaque-key", profileId: "ai-coding", displayName: "Conversation", createdAt: 1 }
  const input = { instanceId: "instance1", principalId: "owner", commandId: "create1", session }
  try {
    expect(registry.create(input)).toEqual(session)
    expect(registry.create({ ...input, session: { ...session, sessionId: "unused", storageKey: "unused" } })).toEqual(session)
    expect(() => registry.create({ ...input, session: { ...session, profileId: "other" } })).toThrow("idempotency_conflict")
    registry.close()
    registry = openHostSessionRegistry(directory)
    expect(registry.get("s1")).toEqual(session)
    expect([...registry.list()]).toEqual([session])
    expect(registry.create({ ...input, principalId: "other", session: { ...session, sessionId: "s2", storageKey: "another" } }).sessionId).toBe("s2")
  } finally { registry.close(); await rm(directory, { recursive: true, force: true }) }
})
