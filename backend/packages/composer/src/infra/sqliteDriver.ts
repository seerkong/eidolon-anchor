import path from "path";
import { existsSync } from "fs";
import { createRequire } from "module";
import { AppConstConfig } from "@shared/composer";

type Sqlite3Driver = {
  verbose?: () => Sqlite3Driver;
};

const localRequire = createRequire(import.meta.url);

export const loadSqlite3Driver = (): Sqlite3Driver => {
  const resourcesDir = process.env[AppConstConfig.env.resourcesDir];
  const cwd = process.cwd();
  const candidates = [
    resourcesDir ? path.join(resourcesDir, "node_modules", "sqlite3", "lib", "sqlite3.js") : null,
    path.join(cwd, "node_modules", "sqlite3", "lib", "sqlite3.js"),
    path.join(cwd, "..", "node_modules", "sqlite3", "lib", "sqlite3.js"),
    path.join(cwd, "Resources", "node_modules", "sqlite3", "lib", "sqlite3.js"),
  ].filter(Boolean) as string[];

  for (const entry of candidates) {
    if (existsSync(entry)) {
      return localRequire(entry) as Sqlite3Driver;
    }
  }

  return localRequire("sqlite3") as Sqlite3Driver;
};
