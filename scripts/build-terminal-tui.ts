import { mkdir } from "fs/promises";
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

const proc = Bun.spawn(
  ["bun", "--config=./scripts/bunfig.build.toml", "./scripts/build.ts", outFile],
  {
    cwd: path.resolve("terminal", "packages", "tui"),
    stdio: ["ignore", "inherit", "inherit"],
  }
);

const exitCode = await proc.exited;
if (exitCode !== 0) {
  process.exit(1);
}
