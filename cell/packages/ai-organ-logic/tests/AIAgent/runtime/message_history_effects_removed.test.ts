import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";

// Source-level conformance for behavior delta
// `legacy-write-path-removed` / case `message-history-effects-removed`:
// the no-op MessageHistoryEffects shim (LocalFileMessageHistoryEffects +
// its MessageHistoryEffects port hop + the executor call sites) is removed
// from the live execution path. The session-upgrade legacy migration readers
// and dirty-data rejection guards are NOT shims and are retained (covered by
// case `migration-readers-retained`).
const repoRoot = path.resolve(import.meta.dir, "../../../../../..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf-8");
}

describe("legacy-write-path-removed / message-history-effects-removed", () => {
  it("LocalFileMessageHistoryEffects shim file no longer exists", () => {
    expect(
      fs.existsSync(
        path.join(
          repoRoot,
          "cell/packages/ai-support/src/runtime/LocalFileMessageHistoryEffects.ts",
        ),
      ),
    ).toBe(false);
  });

  it("@cell/ai-support no longer exports the shim factory/class", () => {
    const supportIndex = readSource("cell/packages/ai-support/src/index.ts");
    expect(supportIndex).not.toContain("LocalFileMessageHistoryEffects");
    expect(supportIndex).not.toContain("createLocalFileMessageHistoryEffects");
  });

  it("kernel runtime support descriptor no longer wires the no-op message history effect", () => {
    const kernelSupport = readSource("cell/packages/mod-ai-kernel/src/support/index.ts");
    expect(kernelSupport).not.toContain("createLocalFileMessageHistoryEffects");
    expect(kernelSupport).not.toContain("createMessageHistoryEffects");
  });

  it("ai-core-contract no longer declares the MessageHistoryEffects port type", () => {
    const historyEffects = readSource(
      "cell/packages/ai-core-contract/src/runtime/HistoryEffects.ts",
    );
    expect(historyEffects).not.toContain("MessageHistoryEffects");
    expect(historyEffects).not.toContain("MessageHistoryAppendEvent");
    expect(historyEffects).not.toContain("MessageHistoryBackupParams");

    const composer = readSource("cell/packages/ai-core-contract/src/runtimeComposer.ts");
    expect(composer).not.toContain("createMessageHistoryEffects");
    expect(composer).not.toContain("MessageHistoryEffects");
  });

  it("AiAgentVm runtime effects no longer expose the messageHistory effect port", () => {
    const vm = readSource("cell/packages/ai-core-contract/src/runtime/AiAgentVm.ts");
    expect(vm).not.toContain("messageHistory?:");
  });

  it("AiAgentExecutor no longer accesses or invokes vm.effects.messageHistory", () => {
    const executor = readSource(
      "cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts",
    );
    expect(executor).not.toContain("vm.effects.messageHistory");
    expect(executor).not.toContain("effects.messageHistory?.appendMessage");
    expect(executor).not.toContain("messageHistory?.backupHistory");
  });

  it("ShellRuntimeBootstrap no longer wires the messageHistory effect into the vm", () => {
    const bootstrap = readSource(
      "cell/packages/ai-organ-logic/src/runtime/ShellRuntimeBootstrap.ts",
    );
    expect(bootstrap).not.toContain("createMessageHistoryEffects");
    expect(bootstrap).not.toContain("messageHistoryEffect");
  });

  it("retains the session-upgrade legacy migration machinery (not a shim)", () => {
    const controlComposer = readSource(
      "cell/packages/ai-runtime-control-composer/src/index.ts",
    );
    // migration-readers-retained: the upgrade dry-run/apply readers stay.
    expect(controlComposer).toContain("dryRunFileStoreAiRuntimeSessionUpgrade");
    expect(controlComposer).toContain("applyFileStoreAiRuntimeSessionUpgrade");
  });
});
