import { existsSync } from "node:fs";
import path from "node:path";

import {
  BUILTIN_EIDOLON_SNAPSHOT_FILE_NAME,
  BUILTIN_EIDOLON_VFS_ASSET_PREFIX,
} from "../../../../cell/packages/mod-ai-coding/src/builtin-vfs/constants";

export const builtinEidolonVfsAssetRoot = path.resolve(
  import.meta.dir,
  "../../../../cell/packages/mod-ai-coding/src/builtin-vfs",
);

export const builtinEidolonVfsSnapshotPath = path.join(
  builtinEidolonVfsAssetRoot,
  BUILTIN_EIDOLON_SNAPSHOT_FILE_NAME,
);

export function assertBuiltinEidolonVfsSnapshot(): void {
  if (!existsSync(builtinEidolonVfsSnapshotPath)) {
    throw new Error(`Missing generated Builtin Eidolon VFS snapshot: ${builtinEidolonVfsSnapshotPath}`);
  }
}

export function injectBuiltinEidolonVfsAssetImport(source: string): string {
  assertBuiltinEidolonVfsSnapshot();
  const shebangEnd = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
  const assetImport = `import ${JSON.stringify(builtinEidolonVfsSnapshotPath)} with { type: "file" };\n`;
  return `${source.slice(0, shebangEnd)}${assetImport}${source.slice(shebangEnd)}`;
}

export function builtinEidolonVfsCompileArgs(entrypoint: string, outfile: string): string[] {
  assertBuiltinEidolonVfsSnapshot();
  return [
    "build",
    "--compile",
    "--target",
    "bun",
    "--outfile",
    outfile,
    "--root",
    builtinEidolonVfsAssetRoot,
    "--asset-naming",
    `${BUILTIN_EIDOLON_VFS_ASSET_PREFIX}[name].[ext]`,
    entrypoint,
  ];
}
