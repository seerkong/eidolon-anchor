import type { EidolonVfsReadPort } from "@cell/symbiont-contract/resource/EffectiveEidolonVFS"
import {
  canonicalResourcePackageSourcePath,
  loadResourceTreeFromReadPort,
  type AuthoredResourceTree,
  type ResourcePackageReadPort,
} from "halfcode-compiler.xnl/resource-core"

/** Immutable builtin authorities, captured with an Effective VFS closure. */
export const EIDOLON_TRUSTED_KIND_DEFINITION_PACKAGE_ROOTS = Object.freeze([
  "/.eidolon/contracts/ai-workflow",
] as const)

export function createEidolonVfsResourcePackageReadPort(readPort: EidolonVfsReadPort): ResourcePackageReadPort {
  return Object.freeze({
    async stat(sourcePath: string) {
      const entry = await readPort.stat(canonicalResourcePackageSourcePath(sourcePath))
      return entry ? Object.freeze({ kind: entry.kind }) : undefined
    },
    async readDirectory(sourcePath: string) {
      const entries = await readPort.readDirectory(canonicalResourcePackageSourcePath(sourcePath))
      return entries?.map(entry => Object.freeze({ name: entry.logicalPath.split("/").at(-1) ?? "", kind: entry.kind }))
    },
    async readBytes(sourcePath: string) {
      return readPort.readBytes(canonicalResourcePackageSourcePath(sourcePath))
    },
  })
}

export async function loadEidolonTrustedKindDefinitionImports(
  readPort: EidolonVfsReadPort,
): Promise<readonly AuthoredResourceTree[]> {
  return loadTrustedKindDefinitionImportsFromResourcePort(createEidolonVfsResourcePackageReadPort(readPort))
}

export async function loadTrustedKindDefinitionImportsFromResourcePort(
  port: ResourcePackageReadPort,
): Promise<readonly AuthoredResourceTree[]> {
  const roots: string[] = []
  for (const rootPath of EIDOLON_TRUSTED_KIND_DEFINITION_PACKAGE_ROOTS) {
    if (await port.stat(`${rootPath}/manifest.xnl`)) roots.push(rootPath)
  }
  return Object.freeze(await Promise.all(roots.map(rootPath => loadResourceTreeFromReadPort({ port, rootPath }))))
}
