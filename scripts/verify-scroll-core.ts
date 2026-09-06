import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cwd = `${root}/shared/packages/depa-scroll-logic`;
// Reuse the workspace's installed compiler; this loads no application modules.
const compiler = Bun.resolveSync("typescript/lib/tsc.js", `${root}/cell`);
for (const command of [
  [process.execPath, compiler, "--noEmit", "-p", "tsconfig.json"],
  [process.execPath, "test", "--coverage", "tests/"],
]) {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, timeout: 60_000 });
  const output = result.stdout.toString() + result.stderr.toString();
  process.stdout.write(output);
  assert.equal(result.exitCode, 0, `Core verification failed: ${command.join(" ")}`);
  assert(!result.signalCode, "Core verification interrupted");
  if (command.includes("--coverage")) {
    const sources = [...output.matchAll(/^\s*(src\/[^|]+)\|\s*[\d.]+\s*\|\s*([\d.]+)\s*\|/gm)];
    assert(sources.some(([ , path]) => path.trim() === "src/index.ts"), "Missing processor coverage");
    assert(sources.some(([ , path]) => path.trim() === "src/geometry.ts"), "Missing geometry coverage");
    for (const [, path, coverage] of sources) assert(Number(coverage) >= 80, `${path.trim()} line coverage below 80%`);
  }
}
console.info("CORE_VERIFIED: strict public-source typecheck, behavioral/property/boundary tests, >=80% lines per core source");
