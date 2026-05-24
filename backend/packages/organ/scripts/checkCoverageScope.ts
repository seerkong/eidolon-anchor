import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type CoverageScopeConfig = {
  threshold: {
    lines: number;
  };
  include_prefixes: string[];
  exclude_substrings: string[];
};

type FileCoverage = {
  filePath: string;
  found: number;
  hit: number;
};

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function parseLcov(content: string): FileCoverage[] {
  const rows = content.split(/\r?\n/);
  const list: FileCoverage[] = [];

  let currentPath: string | null = null;
  let found = 0;
  let hit = 0;

  const flush = () => {
    if (!currentPath) {
      return;
    }
    list.push({ filePath: normalizePath(currentPath), found, hit });
    currentPath = null;
    found = 0;
    hit = 0;
  };

  for (const row of rows) {
    if (row.startsWith("SF:")) {
      flush();
      currentPath = row.slice(3).trim();
      continue;
    }
    if (row.startsWith("DA:")) {
      const values = row.slice(3).split(",");
      if (values.length < 2) {
        continue;
      }
      const hits = Number(values[1]);
      if (Number.isFinite(hits)) {
        found += 1;
        if (hits > 0) {
          hit += 1;
        }
      }
      continue;
    }
    if (row === "end_of_record") {
      flush();
    }
  }

  flush();
  return list;
}

function pct(hit: number, found: number): number {
  if (found <= 0) {
    return 0;
  }
  return (hit / found) * 100;
}

function matchesScope(item: FileCoverage, config: CoverageScopeConfig): boolean {
  const path = normalizePath(item.filePath);

  const isIncluded = config.include_prefixes.some((prefix) => path.includes(normalizePath(prefix)));
  if (!isIncluded) {
    return false;
  }

  const isExcluded = config.exclude_substrings.some((part) => path.includes(normalizePath(part)));
  return !isExcluded;
}

function main() {
  const cwd = process.cwd();
  const configPath = resolve(cwd, "coverage.scope.json");
  const lcovPath = resolve(cwd, "coverage", "lcov.info");

  const config = JSON.parse(readFileSync(configPath, "utf8")) as CoverageScopeConfig;
  const lcov = readFileSync(lcovPath, "utf8");

  const records = parseLcov(lcov).filter((item) => matchesScope(item, config));

  const totalFound = records.reduce((sum, item) => sum + item.found, 0);
  const totalHit = records.reduce((sum, item) => sum + item.hit, 0);
  const ratio = totalFound > 0 ? totalHit / totalFound : 0;
  const ratioPercent = pct(totalHit, totalFound);
  const thresholdPercent = config.threshold.lines * 100;

  if (records.length === 0 || totalFound === 0) {
    console.error("Coverage scope check failed: no matched files or executable lines in scope.");
    process.exit(1);
  }

  console.log(`Scoped coverage lines: ${ratioPercent.toFixed(2)}% (${totalHit}/${totalFound})`);
  console.log(`Threshold: ${thresholdPercent.toFixed(2)}%`);

  const sorted = [...records].sort((a, b) => pct(a.hit, a.found) - pct(b.hit, b.found));
  console.log("Lowest covered files in scope:");
  for (const item of sorted.slice(0, 5)) {
    console.log(`- ${item.filePath}: ${pct(item.hit, item.found).toFixed(2)}% (${item.hit}/${item.found})`);
  }

  if (ratio < config.threshold.lines) {
    console.error("Coverage scope check failed: threshold not met.");
    process.exit(1);
  }

  console.log("Coverage scope check passed.");
}

main();
