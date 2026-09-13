import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const result = Bun.spawnSync(["git", "ls-files", "--others", "--exclude-standard", "-z"], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
})

if (result.exitCode !== 0) {
  process.stderr.write(result.stderr)
  throw new Error("Unable to inspect untracked source artifacts.")
}

const artifacts = result.stdout.toString().split("\0").filter((path) =>
  /(?:^|\/)src\/.*\.js$/.test(path),
)

if (artifacts.length > 0) {
  process.stderr.write([
    "Untracked JavaScript exists under a source directory.",
    "Direct TypeScript emits must use noEmit or an explicit dist output directory.",
    ...artifacts.map((path) => `- ${path}`),
    "",
  ].join("\n"))
  process.exit(1)
}

console.log("No untracked JavaScript artifacts under source directories.")
