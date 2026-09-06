import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packages = fileURLToPath(new URL("../../", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

for (const name of ["depa-scroll-contract", "depa-scroll-logic"]) {
  test(`${name} exposes a private framework-neutral package`, () => {
    const directory = join(packages, name);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    expect(manifest.name).toBe(name);
    expect(manifest.private).toBe(true);
    expect(manifest.exports["."].default).toBe("./src/index.ts");
    expect(manifest.exports["."].types).toBe("./src/index.ts");
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(
      name === "depa-scroll-contract" ? [] : ["depa-scroll-contract"],
    );
    for (const path of sourceFiles(join(directory, "src"))) {
      const source = readFileSync(path, "utf8");
      const imports = [...source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)];
      for (const [, specifier] of imports) {
        expect(specifier === "depa-scroll-contract" || specifier.startsWith("./")).toBe(true);
      }
      expect(source).not.toMatch(/\b(?:fetch|setTimeout|setInterval|queueMicrotask|require)\s*\(/);
      expect(source).not.toMatch(/\b(?:Conversation|TuiA1Message|CliRenderer|ActorSystem)\b/);
    }
  });
}
