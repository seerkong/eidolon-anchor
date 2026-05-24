import { spawn } from "bun";
import path from "path";

const platform = process.platform;
const shellDir = path.resolve(import.meta.dir, "..");
const script =
  platform === "darwin"
    ? path.join("scripts", "build-macos.ts")
    : platform === "win32"
      ? path.join("scripts", "build-windows.ts")
      : null;

if (!script) {
  console.error(`Desktop build is only supported on macOS and Windows. Detected platform: ${platform}.`);
  process.exit(1);
}

const proc = spawn({
  cmd: ["bun", "run", script],
  cwd: shellDir,
  stdout: "inherit",
  stderr: "inherit",
});
const code = await proc.exited;
process.exit(code);
