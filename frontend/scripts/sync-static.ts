import { existsSync } from "fs";
import { cp, mkdir } from "fs/promises";
import path from "path";

type Shell = "vue" | "react";

const frontendRoot = path.resolve(import.meta.dir, "..");
const staticDir = path.join(frontendRoot, "static");
const validShells: Shell[] = ["vue", "react"];

const requestedShell = process.argv[2]?.toLowerCase() as Shell | undefined;
const shells: Shell[] = requestedShell && validShells.includes(requestedShell) ? [requestedShell] : validShells;

async function syncShell(shell: Shell) {
  const target = path.join(frontendRoot, "packages", shell, "public");
  await mkdir(target, { recursive: true });
  if (!existsSync(staticDir)) {
    console.warn(`Skip syncing for ${shell}: static dir not found at ${staticDir}`);
    return;
  }
  await cp(staticDir, target, { recursive: true, dereference: true });
}

async function main() {
  await Promise.all(shells.map((shell) => syncShell(shell)));
  console.log(`Synced static assets${requestedShell ? ` for ${requestedShell}` : ""} from ${staticDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
