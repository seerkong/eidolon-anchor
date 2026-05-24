import path from "node:path";
import { realpath } from "node:fs/promises";

const packageDir = process.cwd();
const viteBin = await realpath(path.join(packageDir, "node_modules", "vite", "bin", "vite.js"));

const esbuildPlatformPackage = `@esbuild/${process.platform}-${process.arch}`;
const esbuildBinary =
  process.platform === "win32"
    ? path.join(packageDir, "node_modules", ...esbuildPlatformPackage.split("/"), "esbuild.exe")
    : path.join(packageDir, "node_modules", ...esbuildPlatformPackage.split("/"), "bin", "esbuild");

const env = {
  ...process.env,
  ...(await Bun.file(esbuildBinary).exists() ? { ESBUILD_BINARY_PATH: esbuildBinary } : {}),
};

const proc = Bun.spawn({
  cmd: ["node", viteBin, ...process.argv.slice(2)],
  cwd: packageDir,
  env,
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await proc.exited);
