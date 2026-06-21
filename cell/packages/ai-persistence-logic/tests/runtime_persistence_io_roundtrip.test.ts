/**
 * P2 move-equivalence harness (track refactor-persistent-session-backplane,
 * T2.1). Proves the moved pure-I/O routing in @cell/ai-persistence-logic
 * round-trips a snapshot/derived-index payload writer -> reader through the
 * injected {@link RuntimePersistenceSupport}, independently of any
 * ai-organ-logic live-runtime reconstruction.
 *
 * This is the package-local witness that the byte-level
 * serialize+write / read+deserialize routing behaves equivalently after the
 * seam cut: what `writeSnapshot` + `writeDerivedIndexes` persist is exactly what
 * `loadSnapshot` + `loadDerivedIndexes` return, and `hasRuntimeSnapshot`
 * reflects manifest presence.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  configureRuntimePersistenceSupport,
  getRuntimeSnapshotRepository,
  hasRuntimeSnapshot,
  writeDerivedIndexes,
  loadDerivedIndexes,
  getConversationPersistenceRepository,
  assertSupportedSnapshotShape,
  type RuntimePersistenceSupport,
} from "@cell/ai-persistence-logic";
import type { RuntimeDerivedIndexes } from "@cell/ai-organ-contract/persistence/RuntimeDerivedIndexes";

function makeEmptyIndexes(): RuntimeDerivedIndexes {
  const updatedAt = "1970-01-01T00:00:00.000Z";
  return {
    memberRoster: { version: 1, members: [], updatedAt },
    detachedActors: { version: 1, tasks: [], updatedAt },
    coordinationRecords: { version: 1, records: [], updatedAt },
  };
}

/** Minimal in-memory persistence support mirroring the file-backed factories' shape. */
function makeInMemorySupport(): RuntimePersistenceSupport {
  const snapshotStore = new Map<string, { manifest: any | null; snapshot: any | null }>();
  const indexStore = new Map<string, RuntimeDerivedIndexes>();
  const ensure = (sessionDir: string) => {
    let entry = snapshotStore.get(sessionDir);
    if (!entry) {
      entry = { manifest: null, snapshot: null };
      snapshotStore.set(sessionDir, entry);
    }
    return entry;
  };
  return {
    snapshotRepositoryFactory: {
      createRuntimeSnapshotRepository(sessionDir: string) {
        const entry = ensure(sessionDir);
        return {
          async readManifest() {
            return entry.manifest;
          },
          async writeManifest(manifest: any) {
            entry.manifest = manifest;
          },
          async writeSnapshot(input: any) {
            entry.snapshot = input;
            const manifest = {
              version: 1,
              controlActorKey: input.vm?.controlActorKey ?? "control",
              createdAt: "1970-01-01T00:00:00.000Z",
              updatedAt: "1970-01-01T00:00:00.000Z",
            };
            entry.manifest = manifest;
            return manifest as any;
          },
          async loadSnapshot() {
            if (!entry.snapshot || !entry.manifest) return null;
            return {
              manifest: entry.manifest,
              vm: entry.snapshot.vm,
              actors: entry.snapshot.actors,
              fibers: entry.snapshot.fibers,
              questionnaires: entry.snapshot.questionnaires,
              corruptions: [],
            } as any;
          },
        };
      },
    } as any,
    derivedIndexesStore: {
      async write({ sessionDir, indexes }) {
        indexStore.set(sessionDir, indexes);
      },
      async load({ sessionDir }) {
        return indexStore.get(sessionDir) ?? makeEmptyIndexes();
      },
    },
  };
}

describe("ai-persistence-logic pure-I/O routing (P2 move-equivalence)", () => {
  beforeEach(() => {
    configureRuntimePersistenceSupport(makeInMemorySupport());
  });

  it("hasRuntimeSnapshot reflects manifest presence", async () => {
    expect(await hasRuntimeSnapshot("/session-a")).toBe(false);
    const repo = getRuntimeSnapshotRepository("/session-a");
    await repo.writeSnapshot({
      vm: { controlActorKey: "control", version: 1 },
      actors: { control: { key: "control" } },
      fibers: {},
      questionnaires: [],
    } as any);
    expect(await hasRuntimeSnapshot("/session-a")).toBe(true);
  });

  it("writer -> reader round-trips the snapshot payload through the injected support", async () => {
    const repo = getRuntimeSnapshotRepository("/session-b");
    const payload = {
      vm: { controlActorKey: "control", version: 7, marker: "vm-truth" },
      actors: { control: { key: "control", id: "a-1" } },
      fibers: { f1: { fiberId: "f1" } },
      questionnaires: [{ id: "q1" }],
    };
    await repo.writeSnapshot(payload as any);
    const loaded = await repo.loadSnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded!.vm).toEqual(payload.vm as any);
    expect(loaded!.actors).toEqual(payload.actors as any);
    expect(loaded!.fibers).toEqual(payload.fibers as any);
    // The deserialize-side shape guard accepts a well-formed payload.
    expect(() =>
      assertSupportedSnapshotShape({
        manifest: loaded!.manifest as Record<string, unknown>,
        vm: loaded!.vm as Record<string, unknown>,
      }),
    ).not.toThrow();
  });

  it("derived-index writer -> reader round-trips the index payload", async () => {
    const indexes = makeEmptyIndexes();
    indexes.memberRoster.members.push({
      memberId: "m1",
      actorKey: "k1",
      actorId: "a1",
      name: "n",
      role: "r",
      agentType: "t",
      lane: "member",
      lifecycleState: "active",
      lastActiveAt: 123,
    });
    await writeDerivedIndexes("/session-c", indexes);
    const loaded = await loadDerivedIndexes("/session-c");
    expect(loaded.memberRoster.members).toHaveLength(1);
    expect(loaded.memberRoster.members[0]?.memberId).toBe("m1");
  });

  it("assertSupportedSnapshotShape hard-fails an unsupported (control-actor-less) payload", () => {
    expect(() => assertSupportedSnapshotShape({ manifest: {}, vm: {} })).toThrow(
      /invalid_runtime_snapshot/,
    );
  });

  it("conversation-persistence repo is null when no factory is injected (memory-only profile)", () => {
    expect(getConversationPersistenceRepository("/session-d")).toBeNull();
  });
});

/**
 * Executable location-boundary coverage for behavior-delta requirement
 * `backplane-package-boundary` case `recovery-reader-in-package`:
 *
 *   "快照写入器、recovery 读取器、derived-index I/O SHALL 位于专用 persistence 包,
 *    而非 ai-organ-logic 逻辑模块内."
 *
 * The behavioral round-trip suite above proves the I/O *routes through*
 * `@cell/ai-persistence-logic`. This suite adds the structural assertion that
 * the snapshot-repository access, the derived-index read/write and the
 * conversation-persistence repo access are RESIDENT in the dedicated package
 * (re-exported from its barrel, defined in `RuntimePersistenceIo.ts`), and that
 * the recovery read port (`RecoveryReadPort.ts`, the recovery reader) sources its
 * single-truth reads THROUGH this package rather than via inline byte-I/O in the
 * ai-organ-logic live module.
 */
describe("backplane-package-boundary: recovery-reader-in-package (location)", () => {
  const packageSrcRoot = path.resolve(import.meta.dir, "../src");
  const ioModulePath = path.join(packageSrcRoot, "RuntimePersistenceIo.ts");
  const cellPackagesRoot = path.resolve(import.meta.dir, "../../");
  const recoveryReadPortPath = path.join(
    cellPackagesRoot,
    "ai-organ-logic",
    "src",
    "persistence",
    "RecoveryReadPort.ts",
  );

  it("the snapshot writer/reader + derived-index I/O routing live in the dedicated persistence package", () => {
    // Resident as exported package surface (the barrel re-exports them).
    expect(typeof getRuntimeSnapshotRepository).toBe("function");
    expect(typeof hasRuntimeSnapshot).toBe("function");
    expect(typeof writeDerivedIndexes).toBe("function");
    expect(typeof loadDerivedIndexes).toBe("function");
    expect(typeof getConversationPersistenceRepository).toBe("function");

    // Defined in the package's pure-I/O module, not somewhere in ai-organ-logic.
    const ioSource = fs.readFileSync(ioModulePath, "utf-8");
    expect(ioSource.includes("export function getRuntimeSnapshotRepository")).toBe(true);
    expect(ioSource.includes("export async function hasRuntimeSnapshot")).toBe(true);
    expect(ioSource.includes("export async function writeDerivedIndexes")).toBe(true);
    expect(ioSource.includes("export async function loadDerivedIndexes")).toBe(true);
    expect(ioSource.includes("export function getConversationPersistenceRepository")).toBe(true);
    // The package must not IMPORT the live-runtime logic host (no cycle / no
    // co-location of orchestration with the byte-I/O routing). Match an actual
    // import specifier, not the doc-comment prose that states the invariant.
    expect(/from\s+["']@cell\/ai-organ-logic/.test(ioSource)).toBe(false);
  });

  it("the recovery reader (RecoveryReadPort) sources its single truth THROUGH the persistence package", () => {
    const recoveryReaderSource = fs.readFileSync(recoveryReadPortPath, "utf-8");
    // The recovery reader resolves its conversation-source repo and its
    // snapshot-existence check from @cell/ai-persistence-logic, not via an inline
    // file-store handle constructed in the ai-organ-logic live module.
    expect(recoveryReaderSource.includes('from "@cell/ai-persistence-logic"')).toBe(true);
    expect(recoveryReaderSource.includes("getConversationPersistenceRepository")).toBe(true);
    expect(recoveryReaderSource.includes("hasRuntimeSnapshot")).toBe(true);
  });
});
