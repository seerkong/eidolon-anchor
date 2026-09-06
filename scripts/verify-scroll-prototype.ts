import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const compiler = Bun.resolveSync("typescript/lib/tsc.js", resolve(root, "cell"));
const full = process.argv.includes("--full");
function run(args: string[], cwd = root) {
  const result = Bun.spawnSync([process.execPath, ...args], { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0 || result.signalCode) throw new Error(`Scroll verification failed: ${args.join(" ")}`);
}
for (const name of ["depa-scroll-opentui-support", "depa-scroll-opentui-capsule", "scroll-prototype"]) {
  run([compiler, "-p", `terminal/packages/${name}/tsconfig.json`]);
}
run(["test", "terminal/packages/depa-scroll-opentui-support/tests", "terminal/packages/depa-scroll-opentui-capsule/tests"]);
run(["test", "--preload", "./src/preload.ts", "tests/source.test.ts", "tests/smoke.test.ts", "fixtures", ...(full ? ["tests/matrix.test.ts"] : [])],
  resolve(root, "terminal/packages/scroll-prototype"));
if (full) run(["--preload", "./src/preload.ts", "tests/benchmark.ts"], resolve(root, "terminal/packages/scroll-prototype"));
