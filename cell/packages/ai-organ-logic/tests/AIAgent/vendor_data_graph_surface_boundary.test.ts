import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";
import * as depaDataGraphCore from "depa-data-graph-core";

const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const targetDataGraphVersion = "1.0.1";
const targetDataGraphRange = `^${targetDataGraphVersion}`;

type PackageManifest = {
  dependencies?: Record<string, string>;
};

type BunLockPackageRecord = [
  resolution: string,
  registry: string,
  metadata: {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  },
  integrity: string,
];

type BunLock = {
  workspaces: Record<string, PackageManifest>;
  packages: Record<string, BunLockPackageRecord>;
};

const directDataGraphDependencyManifests = [
  {
    path: "cell/packages/ai-core-logic/package.json",
    dependencies: { "depa-data-graph-core": targetDataGraphRange },
  },
  {
    path: "cell/packages/ai-organ-logic/package.json",
    dependencies: { "depa-data-graph-core": targetDataGraphRange },
  },
  {
    path: "cell/packages/symbiont-contract/package.json",
    dependencies: { "depa-data-graph-core": targetDataGraphRange },
  },
  {
    path: "terminal/packages/organ/package.json",
    dependencies: { "depa-data-graph-core": targetDataGraphRange },
  },
  {
    path: "terminal/packages/tui/package.json",
    dependencies: {
      "depa-data-graph-core": targetDataGraphRange,
      "depa-data-graph-solid": targetDataGraphRange,
    },
  },
] as const;

function readPackageManifest(relativePath: string): PackageManifest {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8")) as PackageManifest;
}

function parseBunLock(): { lock: BunLock; text: string } {
  const text = fs.readFileSync(path.join(repoRoot, "bun.lock"), "utf8");
  const jsonText = text.replace(/,\s*([}\]])/g, "$1");

  return { lock: JSON.parse(jsonText) as BunLock, text };
}

describe("vendor data-graph surface boundary", () => {
  it("resolves every direct data-graph manifest and bun lock entry to the unified release", () => {
    const { lock, text: lockfileText } = parseBunLock();

    for (const manifestExpectation of directDataGraphDependencyManifests) {
      const manifest = readPackageManifest(manifestExpectation.path);
      const workspacePath = manifestExpectation.path.replace(/\/package\.json$/, "");
      const lockWorkspace = lock.workspaces[workspacePath];

      for (const [dependencyName, expectedRange] of Object.entries(manifestExpectation.dependencies)) {
        expect(manifest.dependencies?.[dependencyName]).toBe(expectedRange);
        expect(lockWorkspace?.dependencies?.[dependencyName]).toBe(expectedRange);
      }
    }

    expect(lock.packages["depa-data-graph-core"]?.[0]).toBe(
      `depa-data-graph-core@${targetDataGraphVersion}`,
    );
    expect(lock.packages["depa-data-graph-solid"]?.[0]).toBe(
      `depa-data-graph-solid@${targetDataGraphVersion}`,
    );
    expect(lock.packages["depa-data-graph-solid"]?.[2].dependencies?.["depa-data-graph-core"]).toBe(
      targetDataGraphVersion,
    );

    expect(lockfileText).not.toMatch(/depa-data-graph-core@0\.1\./);
    expect(lockfileText).not.toMatch(/depa-data-graph-solid@0\.1\./);
  });

  it("exports unified generic state-node and timeline foundations only", () => {
    const exportedNames = Object.keys(depaDataGraphCore);

    const requiredUnifiedExports = [
      "DataGraph",
      "OrderedTimeline",
      "AppendOnlyEventLog",
      "defineGraphModule",
      "mountGraph",
      "state",
      "signalState",
      "streamState",
      "signalDrivenStateSignal",
      "signalDrivenStateStream",
      "streamDrivenStateSignal",
      "streamDrivenStateStream",
      "createAIStream",
    ];

    for (const exportName of requiredUnifiedExports) {
      expect(exportedNames).toContain(exportName);
    }

    expect(exportedNames).not.toContain("ReducerProjection");
    expect(exportedNames).not.toContain("createReducerProjection");

    const aiSpecificExports = exportedNames.filter((name) =>
      /lexical|syntactic|semantic|questionnaire|toolcall|transcript/i.test(name),
    );

    expect(aiSpecificExports).toEqual([]);
  });

  it("keeps AI-specific stage and transcript semantics in cell layers", () => {
    const expectedFiles = [
      "cell/packages/ai-core-contract/src/stream/semantic.ts",
      "cell/packages/ai-core-logic/src/stream/transcript/StageTranscript.ts",
      "cell/packages/symbiont-logic/src/stream/OpenAICompletionsNodejsFetchStreamAdapter.ts",
    ];

    for (const relativePath of expectedFiles) {
      expect(fs.existsSync(path.join(repoRoot, relativePath))).toBe(true);
    }
  });
});
