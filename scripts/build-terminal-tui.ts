import { mkdir, copyFile } from "fs/promises";
import path from "path";

const outDir = path.resolve("dist", "terminal", "tui");
const isWindows = process.platform === "win32";
const binaryName = isWindows ? "eidolon.exe" : "eidolon";
const outFile = path.join(outDir, binaryName);
const repoRoot = path.resolve(".");

await mkdir(outDir, { recursive: true });

async function runRequiredBuildStep(command: string[]): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd: repoRoot,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

await runRequiredBuildStep(["bun", "run", "--cwd", "cell/packages/ai-support", "generate:system-skills:check"]);
await runRequiredBuildStep(["bun", "./scripts/generate-tool-prompt-assets.ts"]);

// Build and stage the native Windows sandbox helpers (Zig) so the bundled TUI
// ships with eidolon-windows-sandbox-runner/setup next to the binary.
//
// Cross-platform: the helpers are Windows-only. On non-Windows this block is
// skipped entirely. On Windows, a missing `zig` toolchain is a soft failure —
// we warn and ship without the helpers (the runtime already degrades to
// `disabled`, filesystem-permission sandboxing) rather than aborting the whole
// TUI build. An explicitly-set EIDOLON_ZIG that is missing is still an error.
if (isWindows) {
  const zigExe = process.env.EIDOLON_ZIG || "zig";
  const zigAvailable = Bun.which(zigExe);
  if (!zigAvailable) {
    if (process.env.EIDOLON_ZIG) {
      console.error(`Error: EIDOLON_ZIG points to a missing executable: ${process.env.EIDOLON_ZIG}`);
      process.exit(1);
    }
    console.warn(
      "Warning: 'zig' not found on PATH; skipping the native Windows sandbox helpers.\n" +
        "  The Windows sandbox will fall back to 'disabled' (filesystem permissions only).\n" +
        "  Install Zig 0.16+ (or set EIDOLON_ZIG) and rerun to enable process-level isolation."
    );
  } else {
    const zigBuildProc = Bun.spawn(
      ["bun", "run", "scripts/build.zig.ts"],
      {
        cwd: path.resolve("cell", "packages", "windows-sandbox-runner"),
        stdio: ["ignore", "inherit", "inherit"],
      }
    );
    const zigExitCode = await zigBuildProc.exited;
    if (zigExitCode !== 0) {
      process.exit(zigExitCode);
    }
    const zigDist = path.resolve("cell", "packages", "windows-sandbox-runner", "dist");
    for (const helper of ["eidolon-windows-sandbox-runner.exe", "eidolon-windows-sandbox-setup.exe"]) {
      await copyFile(path.join(zigDist, helper), path.join(outDir, helper));
    }
  }
}

const proc = Bun.spawn(
  ["bun", "--config=./scripts/bunfig.build.toml", "./scripts/build.ts", outFile],
  {
    cwd: path.resolve("terminal", "packages", "tui"),
    env: {
      ...process.env,
      EIDOLON_UNIFIED_ENTRY: path.resolve("terminal", "packages", "cli", "src", "index.ts"),
    },
    stdio: ["ignore", "inherit", "inherit"],
  }
);

const exitCode = await proc.exited;
if (exitCode !== 0) {
  process.exit(1);
}
