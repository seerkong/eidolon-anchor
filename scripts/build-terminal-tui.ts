import { mkdir, copyFile } from "fs/promises";
import path from "path";

const outDir = path.resolve("dist", "terminal", "tui");
const isWindows = process.platform === "win32";
const binaryName = isWindows ? "eidolon.exe" : "eidolon";
const outFile = path.join(outDir, binaryName);

await mkdir(outDir, { recursive: true });

const generatePromptAssetsProc = Bun.spawn(
  ["bun", "./scripts/generate-tool-prompt-assets.ts"],
  {
    cwd: path.resolve("."),
    stdio: ["ignore", "inherit", "inherit"],
  }
);

const generatePromptAssetsExitCode = await generatePromptAssetsProc.exited;
if (generatePromptAssetsExitCode !== 0) {
  process.exit(generatePromptAssetsExitCode);
}

// Build and stage the native Windows sandbox helpers (Zig) so the bundled TUI
// ships with eidolon-windows-sandbox-runner/setup next to the binary.
if (isWindows) {
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
