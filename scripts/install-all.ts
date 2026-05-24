import { spawn } from "bun";
import path from "path";

type Step = {
  name: string;
  cmd: string[];
  cwd: string;
  timeoutMs?: number;
  retries?: number;
};

const repoRoot = path.resolve(import.meta.dir, "..");

const DEFAULT_STEP_TIMEOUT_MS = Number(process.env.INSTALL_ALL_STEP_TIMEOUT_MS ?? 20 * 60 * 1000);
const DEFAULT_HEARTBEAT_MS = Number(process.env.INSTALL_ALL_HEARTBEAT_MS ?? 15 * 1000);
const DEFAULT_INSTALL_RETRIES = Number(process.env.INSTALL_ALL_RETRIES ?? 1);
const ENABLE_VERBOSE = process.env.INSTALL_ALL_VERBOSE === "1";
const DRY_RUN = process.argv.includes("--dry-run");

const installCmd = ["bun", "install", "--no-progress", ...(ENABLE_VERBOSE ? ["--verbose"] : [])];

const steps: Step[] = [
  { name: "shared", cmd: installCmd, cwd: path.join(repoRoot, "shared"), retries: DEFAULT_INSTALL_RETRIES },
  { name: "backend", cmd: installCmd, cwd: path.join(repoRoot, "backend"), retries: DEFAULT_INSTALL_RETRIES },
  {
    name: "frontend",
    cmd: installCmd,
    cwd: path.join(repoRoot, "frontend"),
    retries: DEFAULT_INSTALL_RETRIES,
    timeoutMs: Number(process.env.INSTALL_ALL_FRONTEND_TIMEOUT_MS ?? DEFAULT_STEP_TIMEOUT_MS),
  },
  { name: "desktop", cmd: installCmd, cwd: path.join(repoRoot, "desktop"), retries: DEFAULT_INSTALL_RETRIES },
  { name: "root", cmd: installCmd, cwd: repoRoot, retries: DEFAULT_INSTALL_RETRIES },
];

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

async function runStep(step: Step): Promise<number> {
  const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const retries = step.retries ?? 0;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const attemptLabel = retries > 0 ? ` (attempt ${attempt}/${retries + 1})` : "";
    const startedAt = Date.now();
    console.log(`\n==> Installing ${step.name}${attemptLabel} (${step.cwd})`);

    if (DRY_RUN) {
      console.log(`[dry-run] ${step.cmd.join(" ")}`);
      return 0;
    }

    const proc = spawn({
      cmd: step.cmd,
      cwd: step.cwd,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        BUN_CONFIG_REGISTRY: process.env.BUN_CONFIG_REGISTRY ?? "https://registry.npmjs.org/",
      },
    });

    let timedOut = false;
    const heartbeat = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      console.log(`... ${step.name} still running (${formatMs(elapsed)})`);
    }, DEFAULT_HEARTBEAT_MS);

    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`\n[timeout] ${step.name} exceeded ${formatMs(timeoutMs)}.`);
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000);
    }, timeoutMs);

    try {
      const code = await proc.exited;
      const elapsed = Date.now() - startedAt;

      if (timedOut) {
        throw new Error(
          `Step "${step.name}" timed out after ${formatMs(timeoutMs)}. ` +
            `Try: INSTALL_ALL_FRONTEND_TIMEOUT_MS=3600000 INSTALL_ALL_VERBOSE=1 bun run install:all:bun`
        );
      }

      if (code === 0) {
        console.log(`✓ ${step.name} completed in ${formatMs(elapsed)}`);
        return elapsed;
      }

      if (attempt > retries) {
        throw new Error(`Step "${step.name}" failed with code ${code}`);
      }

      console.warn(`⚠ ${step.name} failed with code ${code}; retrying...`);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    }
  }

  return 0;
}

async function main() {
  const timings: Array<{ name: string; ms: number }> = [];

  if (DRY_RUN) {
    console.log("Running in dry-run mode. No command will be executed.");
  }

  for (const step of steps) {
    const elapsed = await runStep(step);
    timings.push({ name: step.name, ms: elapsed });
  }

  if (!DRY_RUN) {
    console.log("\nStep timing summary:");
    for (const timing of timings) {
      console.log(`- ${timing.name}: ${formatMs(timing.ms)}`);
    }
  }

  console.log("\nAll dependencies installed.");
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
