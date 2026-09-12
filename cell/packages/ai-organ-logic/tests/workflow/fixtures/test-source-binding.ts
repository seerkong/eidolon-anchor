import path from "node:path"

/** Subprocesses inherit an explicit source binding, with repository defaults outside local integration runs. */
export function testSourceTsconfig(): string {
  if (process.env.EIDOLON_TEST_TSCONFIG) return path.resolve(process.env.EIDOLON_TEST_TSCONFIG)
  const root = path.resolve(import.meta.dir, "../../../../../..")
  return path.join(root, "cell/tsconfig.json")
}
