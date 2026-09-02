import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createSourceBuiltinEidolonVfsAssetPort,
  loadBuiltinEidolonResourceTree,
} from "../../../../cell/packages/mod-ai-coding/src/builtin-vfs";
import {
  builtinEidolonVfsCompileArgs,
  injectBuiltinEidolonVfsAssetImport,
} from "../scripts/builtin-vfs-asset";

const temporaryDirectories: string[] = [];

function comparableTree(value: Awaited<ReturnType<typeof loadBuiltinEidolonResourceTree>>) {
  return {
    snapshot: value.builtin.snapshot,
    records: [...value.tree.registry.byKind.entries()]
      .flatMap(([kind, records]) => records.map((record) => ({
        kind,
        resourceId: record.resourceId,
        logicalPath: record.logicalPath,
        documentUri: record.documentUri,
        contentDigest: value.tree.contentIdentities.get(record.resourceId)?.contentDigest,
      })))
      .sort((left, right) => left.resourceId.localeCompare(right.resourceId)),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("final Bun compile Builtin Eidolon VFS asset", () => {
  it("reads the stable BunFS snapshot from a compiled probe without source fallback", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eidolon-builtin-vfs-probe-"));
    temporaryDirectories.push(directory);
    const entrypoint = path.join(directory, "probe.ts");
    const outfile = path.join(directory, "probe");
    const runtimeModule = path.resolve(
      import.meta.dir,
      "../../../../cell/packages/mod-ai-coding/src/builtin-vfs/index.ts",
    );
    const probeSource = injectBuiltinEidolonVfsAssetImport(`
      import { createEmbeddedBuiltinEidolonVfsAssetPort, loadBuiltinEidolonResourceTree } from ${JSON.stringify(runtimeModule)};
      const value = await loadBuiltinEidolonResourceTree(createEmbeddedBuiltinEidolonVfsAssetPort());
      console.log(JSON.stringify({
        source: "bunfs",
        snapshot: value.builtin.snapshot,
        records: [...value.tree.registry.byKind.entries()]
          .flatMap(([kind, records]) => records.map((record) => ({
            kind,
            resourceId: record.resourceId,
            logicalPath: record.logicalPath,
            documentUri: record.documentUri,
            contentDigest: value.tree.contentIdentities.get(record.resourceId)?.contentDigest,
          })))
          .sort((left, right) => left.resourceId.localeCompare(right.resourceId)),
      }));
    `);
    await Bun.write(entrypoint, probeSource);

    const compile = Bun.spawn([process.execPath, ...builtinEidolonVfsCompileArgs(entrypoint, outfile)], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [compileExit, compileError] = await Promise.all([
      compile.exited,
      new Response(compile.stderr).text(),
    ]);
    expect(compileExit, compileError).toBe(0);

    const probe = Bun.spawn([outfile], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [probeExit, output, probeError] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    expect(probeExit, probeError).toBe(0);
    const compiled = JSON.parse(output) as { source: string; snapshot: unknown; records: unknown };
    const source = comparableTree(await loadBuiltinEidolonResourceTree(createSourceBuiltinEidolonVfsAssetPort()));
    expect(compiled.source).toBe("bunfs");
    expect({ snapshot: compiled.snapshot, records: compiled.records }).toEqual(source);
    expect(source.records.find((record) => record.resourceId === "eidolon.coding.CodeAgent"))
      .toMatchObject({ kind: "AIAgentDefinition" });
  }, 60_000);
});
