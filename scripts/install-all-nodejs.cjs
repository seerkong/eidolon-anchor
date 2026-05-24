const { spawn } = require("child_process");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

function runInstall() {
  return new Promise((resolve, reject) => {
    console.log(`\n==> Installing workspaces with bun (${repoRoot})`);
    const proc = spawn("bun", ["install"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`bun install failed with code ${code}`));
    });
  });
}

async function main() {
  await runInstall();
  console.log("\nAll dependencies installed.");
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
